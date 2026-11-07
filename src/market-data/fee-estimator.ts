import { Asset, Horizon } from "@stellar/stellar-sdk";
import { z } from "zod";

import type { AppConfig, TradingPairConfig } from "../config/schema.js";
import { Big } from "../common/decimal.js";
import { createLogger } from "../common/logger.js";
import { withRetry } from "../common/retry.js";
import { isRetryableHorizonError } from "../stellar/horizon-client.js";

const FeeStatsSchema = z.object({
  last_ledger: z.string().regex(/^\d+$/),
  last_ledger_base_fee: z.string().regex(/^\d+$/),
  fee_charged: z.object({
    p95: z.string().regex(/^\d+$/),
  }),
});

export interface FeeRateSnapshot {
  operationFeeStroops: string;
  lastLedger: string;
  fetchedAtMs: number;
}

export interface XlmQuoteConversion {
  quotePerXlm: string;
  path: string[];
  fetchedAtMs: number;
}

export interface FeeDataSource {
  fetchFeeRate(): Promise<FeeRateSnapshot>;
  fetchXlmToQuoteConversion(
    quoteAsset: TradingPairConfig["quote"],
  ): Promise<XlmQuoteConversion>;
}

export interface NetworkFeeEstimate {
  complete: boolean;
  operationCount: number;
  quoteAssetId: string;
  nature: "simulated_estimate";
  feeRateMethod: "max_last_ledger_base_fee_and_fee_charged_p95";
  operationFeeStroops: string | null;
  totalFeeStroops: string | null;
  networkFeeXlm: string | null;
  networkFeeQuote: string | null;
  conversionRateQuotePerXlm: string | null;
  feeStatsLastLedger: string | null;
  feeStatsFetchedAtMs: number | null;
  conversionPath: string[] | null;
  conversionFetchedAtMs: number | null;
  reason: string | null;
  error: string | null;
}

function toSdkAsset(asset: TradingPairConfig["quote"]): Asset {
  return asset.type === "native"
    ? Asset.native()
    : new Asset(asset.code, asset.issuer);
}

function assetId(asset: TradingPairConfig["quote"]): string {
  return asset.type === "native" ? "native" : `${asset.code}:${asset.issuer}`;
}

function isMatchingDestination(
  record: {
    destination_asset_type: string;
    destination_asset_code: string;
    destination_asset_issuer: string;
  },
  quote: TradingPairConfig["quote"],
): boolean {
  if (quote.type === "native") {
    return record.destination_asset_type === "native";
  }

  return record.destination_asset_type === "credit_alphanum4"
    || record.destination_asset_type === "credit_alphanum12"
    ? record.destination_asset_code === quote.code
      && record.destination_asset_issuer === quote.issuer
    : false;
}

function conversionPath(
  record: {
    path: Array<{
      asset_type: string;
      asset_code: string;
      asset_issuer: string;
    }>;
  },
  quote: TradingPairConfig["quote"],
): string[] {
  const intermediates = record.path.map((asset) =>
    asset.asset_type === "native"
      ? "XLM"
      : `${asset.asset_code}:${asset.asset_issuer}`,
  );
  return ["XLM", ...intermediates, assetId(quote)];
}

export class HorizonFeeDataSource implements FeeDataSource {
  private readonly server: InstanceType<typeof Horizon.Server>;
  private readonly logger: ReturnType<typeof createLogger>;

  constructor(private readonly config: AppConfig) {
    this.server = new Horizon.Server(config.horizonUrl);
    this.logger = createLogger(config.logLevel);
  }

  async fetchFeeRate(): Promise<FeeRateSnapshot> {
    const response = await this.request(
      () => this.server.feeStats(),
      "Horizon fee statistics",
    );
    const parsed = FeeStatsSchema.parse(response);
    const currentBase = new Big(parsed.last_ledger_base_fee);
    const recentP95 = new Big(parsed.fee_charged.p95);
    const operationFeeStroops = recentP95.gt(currentBase)
      ? recentP95.toString()
      : currentBase.toString();

    return {
      operationFeeStroops,
      lastLedger: parsed.last_ledger,
      fetchedAtMs: Date.now(),
    };
  }

  async fetchXlmToQuoteConversion(
    quoteAsset: TradingPairConfig["quote"],
  ): Promise<XlmQuoteConversion> {
    if (quoteAsset.type === "native") {
      return {
        quotePerXlm: "1",
        path: ["XLM"],
        fetchedAtMs: Date.now(),
      };
    }

    const quote = toSdkAsset(quoteAsset);
    const { records } = await this.request(
      () => this.server
        .strictSendPaths(Asset.native(), this.config.feeConversionProbeXlm, [quote])
        .call(),
      `XLM conversion path to ${assetId(quoteAsset)}`,
    );

    const matching = records.filter((record) =>
      isMatchingDestination(record, quoteAsset),
    );
    if (matching.length === 0) {
      throw new Error(`No current Horizon path converts XLM to ${assetId(quoteAsset)}`);
    }

    const best = matching.reduce((selected, candidate) =>
      new Big(candidate.destination_amount).gt(selected.destination_amount)
        ? candidate
        : selected,
    );
    const sourceAmount = new Big(best.source_amount);
    const destinationAmount = new Big(best.destination_amount);
    if (!sourceAmount.gt(0) || !destinationAmount.gt(0)) {
      throw new Error("Horizon returned a nonpositive asset conversion amount");
    }

    return {
      quotePerXlm: destinationAmount.div(sourceAmount).toString(),
      path: conversionPath(best, quoteAsset),
      fetchedAtMs: Date.now(),
    };
  }

  private request<T>(operation: () => Promise<T>, purpose: string): Promise<T> {
    return withRetry(
      operation,
      {
        maxRetries: this.config.maxRetries,
        baseDelayMs: this.config.retryBaseDelayMs,
        maxDelayMs: this.config.retryMaxDelayMs,
        onRetry: (error, retryNumber, delayMs) => {
          this.logger.warn(
            { err: error, retryNumber, delayMs, purpose },
            "Retrying Horizon fee data request",
          );
        },
      },
      isRetryableHorizonError,
    );
  }
}

export function roundTripOperationCount(replacementsPerOrder: number): number {
  if (!Number.isInteger(replacementsPerOrder) || replacementsPerOrder < 0) {
    throw new Error("Replacement count must be a nonnegative integer");
  }

  const operationsPerLifecycle = 1 + replacementsPerOrder + 1;
  return operationsPerLifecycle * 2;
}

export class NetworkFeeEstimator {
  private feeRate: FeeRateSnapshot | undefined;
  private feeRateRequest: Promise<FeeRateSnapshot> | undefined;
  private readonly conversions = new Map<string, XlmQuoteConversion>();
  private readonly conversionRequests = new Map<string, Promise<XlmQuoteConversion>>();

  constructor(
    private readonly source: FeeDataSource,
    private readonly config: Pick<AppConfig, "feeDataRefreshMs" | "feeDataMaxAgeMs">,
  ) {}

  async estimateRoundTrip(
    quoteAsset: TradingPairConfig["quote"],
    replacementsPerOrder: number,
    nowMs?: number,
  ): Promise<NetworkFeeEstimate> {
    const currentTime = (): number => nowMs ?? Date.now();
    const operationCount = roundTripOperationCount(replacementsPerOrder);
    const quoteId = assetId(quoteAsset);
    let feeRate: FeeRateSnapshot;
    try {
      feeRate = await this.getFeeRate(currentTime());
    } catch (error) {
      return this.incomplete(operationCount, quoteId, "fee_stats_unavailable", error);
    }

    const feeAgeMs = currentTime() - feeRate.fetchedAtMs;
    if (feeAgeMs < 0 || feeAgeMs > this.config.feeDataMaxAgeMs) {
      return this.incomplete(
        operationCount,
        quoteId,
        "fee_stats_stale",
        undefined,
        feeRate,
      );
    }

    const totalFeeStroops = new Big(feeRate.operationFeeStroops)
      .times(operationCount);
    if (!totalFeeStroops.gt(0)) {
      return this.incomplete(
        operationCount,
        quoteId,
        "fee_rate_invalid",
        undefined,
        feeRate,
      );
    }
    const networkFeeXlm = totalFeeStroops.div(10_000_000);

    let conversion: XlmQuoteConversion;
    try {
      conversion = await this.getConversion(quoteAsset, currentTime());
    } catch (error) {
      return this.incomplete(
        operationCount,
        quoteId,
        "fee_conversion_unavailable",
        error,
        feeRate,
        totalFeeStroops.toString(),
        networkFeeXlm.toString(),
      );
    }

    const conversionAgeMs = currentTime() - conversion.fetchedAtMs;
    if (!new Big(conversion.quotePerXlm).gt(0)) {
      return this.incomplete(
        operationCount,
        quoteId,
        "fee_conversion_invalid",
        undefined,
        feeRate,
        totalFeeStroops.toString(),
        networkFeeXlm.toString(),
      );
    }
    if (conversionAgeMs < 0 || conversionAgeMs > this.config.feeDataMaxAgeMs) {
      return this.incomplete(
        operationCount,
        quoteId,
        "fee_conversion_stale",
        undefined,
        feeRate,
        totalFeeStroops.toString(),
        networkFeeXlm.toString(),
      );
    }

    return {
      complete: true,
      operationCount,
      quoteAssetId: quoteId,
      nature: "simulated_estimate",
      feeRateMethod: "max_last_ledger_base_fee_and_fee_charged_p95",
      operationFeeStroops: feeRate.operationFeeStroops,
      totalFeeStroops: totalFeeStroops.toString(),
      networkFeeXlm: networkFeeXlm.toString(),
      networkFeeQuote: networkFeeXlm.times(conversion.quotePerXlm).toString(),
      conversionRateQuotePerXlm: conversion.quotePerXlm,
      feeStatsLastLedger: feeRate.lastLedger,
      feeStatsFetchedAtMs: feeRate.fetchedAtMs,
      conversionPath: conversion.path,
      conversionFetchedAtMs: conversion.fetchedAtMs,
      reason: null,
      error: null,
    };
  }

  private async getFeeRate(nowMs: number): Promise<FeeRateSnapshot> {
    if (this.feeRate && nowMs - this.feeRate.fetchedAtMs <= this.config.feeDataRefreshMs) {
      return this.feeRate;
    }
    if (this.feeRateRequest) {
      return this.feeRateRequest;
    }

    this.feeRateRequest = this.source.fetchFeeRate()
      .then((feeRate) => {
        this.feeRate = feeRate;
        return feeRate;
      })
      .catch((error: unknown) => {
        if (
          this.feeRate
          && nowMs - this.feeRate.fetchedAtMs <= this.config.feeDataMaxAgeMs
        ) {
          return this.feeRate;
        }
        throw error;
      })
      .finally(() => {
        this.feeRateRequest = undefined;
      });

    return this.feeRateRequest;
  }

  private async getConversion(
    quote: TradingPairConfig["quote"],
    nowMs: number,
  ): Promise<XlmQuoteConversion> {
    const key = assetId(quote);
    const cached = this.conversions.get(key);
    if (cached && nowMs - cached.fetchedAtMs <= this.config.feeDataRefreshMs) {
      return cached;
    }

    const pending = this.conversionRequests.get(key);
    if (pending) {
      return pending;
    }

    const request = this.source.fetchXlmToQuoteConversion(quote)
      .then((conversion) => {
        this.conversions.set(key, conversion);
        return conversion;
      })
      .catch((error: unknown) => {
        if (
          cached
          && nowMs - cached.fetchedAtMs <= this.config.feeDataMaxAgeMs
        ) {
          return cached;
        }
        throw error;
      })
      .finally(() => {
        this.conversionRequests.delete(key);
      });
    this.conversionRequests.set(key, request);
    return request;
  }

  private incomplete(
    operationCount: number,
    quoteAssetId: string,
    reason: string,
    error?: unknown,
    feeRate?: FeeRateSnapshot,
    totalFeeStroops?: string,
    networkFeeXlm?: string,
  ): NetworkFeeEstimate {
    return {
      complete: false,
      operationCount,
      quoteAssetId,
      nature: "simulated_estimate",
      feeRateMethod: "max_last_ledger_base_fee_and_fee_charged_p95",
      operationFeeStroops: feeRate?.operationFeeStroops ?? null,
      totalFeeStroops: totalFeeStroops ?? null,
      networkFeeXlm: networkFeeXlm ?? null,
      networkFeeQuote: null,
      conversionRateQuotePerXlm: null,
      feeStatsLastLedger: feeRate?.lastLedger ?? null,
      feeStatsFetchedAtMs: feeRate?.fetchedAtMs ?? null,
      conversionPath: null,
      conversionFetchedAtMs: null,
      reason,
      error: error instanceof Error ? error.message : error === undefined
        ? null
        : "Fee data request failed",
    };
  }
}
