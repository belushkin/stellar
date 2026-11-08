import { Asset, Horizon } from "@stellar/stellar-sdk";

import type { AppConfig, TradingPairConfig } from "../config/schema.js";
import { createLogger } from "../common/logger.js";
import { withRetry } from "../common/retry.js";
import { isRetryableHorizonError } from "../stellar/horizon-client.js";
import { compareHorizonCursors, parseHorizonCursor } from "../common/horizon-cursor.js";

export interface HorizonTradePrint {
  tradeId: string;
  cursor: string;
  pairId: string;
  baseAmount: string;
  priceNumerator: string;
  priceDenominator: string;
  baseIsSeller: boolean;
  tradeType: string;
  occurredAtMs: number;
  receivedAtMs?: number;
  ledgerCloseTime?: string;
  baseOfferId?: string | null;
  counterOfferId?: string | null;
  baseAccount?: string | null;
  counterAccount?: string | null;
  baseLiquidityPoolId?: string | null;
  counterLiquidityPoolId?: string | null;
  operationId?: string | null;
  transactionHash?: string | null;
  horizonRawJson?: string;
}

export interface TradeStreamHandlers {
  onTrade: (trade: HorizonTradePrint) => void;
  onError: (error: unknown) => void;
}

interface HorizonTradeRecord {
  id: string;
  paging_token: string;
  ledger_close_time: string;
  base_amount: string;
  base_is_seller: boolean;
  trade_type: string;
  price?: { n: string; d: string };
}

function stringField(record: object, key: string): string | null {
  const value: unknown = Reflect.get(record, key);
  return typeof value === "string" ? value : null;
}

function linkedIdentifier(record: object, relationship: "operation" | "transaction"): string | null {
  const links: unknown = Reflect.get(record, "_links");
  if (typeof links !== "object" || links === null) {
    return null;
  }
  const link: unknown = Reflect.get(links, relationship);
  if (typeof link !== "object" || link === null) {
    return null;
  }
  const href: unknown = Reflect.get(link, "href");
  if (typeof href !== "string") {
    return null;
  }
  try {
    const segments = new URL(href, "https://horizon.invalid").pathname.split("/").filter(Boolean);
    const identifier = segments.at(-1);
    return identifier ?? null;
  } catch {
    return null;
  }
}

function toSdkAsset(asset: TradingPairConfig["base"]): Asset {
  return asset.type === "native"
    ? Asset.native()
    : new Asset(asset.code, asset.issuer);
}

function pairId(pair: TradingPairConfig): string {
  const assetId = (asset: TradingPairConfig["base"]): string =>
    asset.type === "native" ? "XLM" : `${asset.code}:${asset.issuer}`;
  return `${assetId(pair.base)}/${assetId(pair.quote)}`;
}

export class HorizonTradeSource {
  private readonly server: InstanceType<typeof Horizon.Server>;
  private readonly logger: ReturnType<typeof createLogger>;

  constructor(private readonly config: AppConfig) {
    this.server = new Horizon.Server(config.horizonUrl);
    this.logger = createLogger(config.logLevel);
  }

  async latestCursor(pair: TradingPairConfig): Promise<string> {
    const response = await withRetry(
      () => this.server
        .trades()
        .forAssetPair(toSdkAsset(pair.base), toSdkAsset(pair.quote))
        .order("desc")
        .limit(1)
        .call(),
      {
        maxRetries: this.config.maxRetries,
        baseDelayMs: this.config.retryBaseDelayMs,
        maxDelayMs: this.config.retryMaxDelayMs,
        onRetry: (error, retryNumber, delayMs) => {
          this.logger.warn(
            { err: error, retryNumber, delayMs, pair },
            "Retrying Horizon trade cursor request",
          );
        },
      },
      isRetryableHorizonError,
    );
    const cursor = response.records[0]?.paging_token;
    if (cursor === undefined) {
      return "now";
    }
    if (!parseHorizonCursor(cursor)) {
      throw new Error(`Horizon returned an unsupported trade paging token: ${cursor}`);
    }
    return cursor;
  }

  async catchUp(
    pair: TradingPairConfig,
    cursor: string,
    onTrade: (trade: HorizonTradePrint) => void,
  ): Promise<{ count: number; lastCursor: string }> {
    if (cursor !== "now" && !parseHorizonCursor(cursor)) {
      throw new Error(`Unsupported Horizon trade backfill cursor: ${cursor}`);
    }
    let response = await withRetry(
      () => this.server
        .trades()
        .forAssetPair(toSdkAsset(pair.base), toSdkAsset(pair.quote))
        .cursor(cursor)
        .order("asc")
        .limit(200)
        .call(),
      {
        maxRetries: this.config.maxRetries,
        baseDelayMs: this.config.retryBaseDelayMs,
        maxDelayMs: this.config.retryMaxDelayMs,
        onRetry: (error, retryNumber, delayMs) => {
          this.logger.warn(
            { err: error, retryNumber, delayMs, pair },
            "Retrying Horizon trade backfill request",
          );
        },
      },
      isRetryableHorizonError,
    );
    let count = 0;
    let lastCursor = cursor;
    while (response.records.length > 0) {
      for (const record of response.records) {
        const trade = this.normalizeRecord(pair, record);
        onTrade(trade);
        count += 1;
        const order = lastCursor === "now"
          ? 1
          : compareHorizonCursors(trade.cursor, lastCursor);
        if (order !== null && order > 0) {
          lastCursor = trade.cursor;
        }
      }
      if (response.records.length < 200) {
        break;
      }
      response = await response.next();
    }
    return { count, lastCursor };
  }

  stream(
    pair: TradingPairConfig,
    cursor: string,
    handlers: TradeStreamHandlers,
  ): () => void {
    return this.server
      .trades()
      .forAssetPair(toSdkAsset(pair.base), toSdkAsset(pair.quote))
      .cursor(cursor)
      .order("asc")
      .stream({
        onmessage: (record) => {
          try {
            handlers.onTrade(this.normalizeRecord(pair, record));
          } catch (error) {
            handlers.onError(error);
          }
        },
        onerror: (event) => handlers.onError(event.data ?? event),
      });
  }

  private normalizeRecord(
    pair: TradingPairConfig,
    record: HorizonTradeRecord,
  ): HorizonTradePrint {
    if (!parseHorizonCursor(record.paging_token)) {
      throw new Error(`Horizon trade ${record.id} has an unsupported paging token`);
    }
    if (
      !record.price
      || !/^\d+$/.test(record.price.n)
      || !/^\d+$/.test(record.price.d)
    ) {
      throw new Error(`Horizon trade ${record.id} has no valid rational price`);
    }
    const occurredAtMs = Date.parse(record.ledger_close_time);
    if (!Number.isFinite(occurredAtMs)) {
      throw new Error(`Horizon trade ${record.id} has an invalid close time`);
    }
    return {
      tradeId: record.id,
      cursor: record.paging_token,
      pairId: pairId(pair),
      baseAmount: record.base_amount,
      priceNumerator: record.price.n,
      priceDenominator: record.price.d,
      baseIsSeller: record.base_is_seller,
      tradeType: record.trade_type,
      occurredAtMs,
      receivedAtMs: Date.now(),
      ledgerCloseTime: record.ledger_close_time,
      baseOfferId: stringField(record, "base_offer_id"),
      counterOfferId: stringField(record, "counter_offer_id"),
      baseAccount: stringField(record, "base_account"),
      counterAccount: stringField(record, "counter_account"),
      baseLiquidityPoolId: stringField(record, "base_liquidity_pool_id"),
      counterLiquidityPoolId: stringField(record, "counter_liquidity_pool_id"),
      operationId: linkedIdentifier(record, "operation"),
      transactionHash: linkedIdentifier(record, "transaction"),
      horizonRawJson: JSON.stringify(record),
    };
  }
}
