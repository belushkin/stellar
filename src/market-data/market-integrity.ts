import type Database from "better-sqlite3";

import { Big } from "../common/decimal.js";
import type { TradingPairConfig } from "../config/schema.js";
import { estimateExecutableVolume } from "../order-book/executable-volume.js";
import { getPairId } from "../order-book/normalize.js";
import type { OrderBookSnapshot } from "../order-book/types.js";
import type { NetworkFeeEstimate } from "./fee-estimator.js";

export function validateOrderBookIntegrity(
  book: OrderBookSnapshot,
  maxAgeMs: number,
  nowMs = Date.now(),
): string[] {
  const reasons: string[] = [];
  const ageMs = nowMs - book.receivedAtMs;
  if (ageMs < 0 || ageMs > maxAgeMs) {
    reasons.push("order_book_stale");
  }
  if (book.bids.length === 0 || book.asks.length === 0) {
    reasons.push("one_sided_order_book");
  } else if (book.bestBid === null || book.bestAsk === null) {
    reasons.push("two_sided_order_book_unavailable");
  } else if (new Big(book.bestBid).gte(book.bestAsk)) {
    reasons.push("order_book_crossed_or_locked");
  }
  return reasons;
}

export function validateFeeConversion(input: {
  estimate: NetworkFeeEstimate;
  quoteAssetId: string;
  referenceBook: OrderBookSnapshot | undefined;
  probeXlm: string;
  maxBookAgeMs: number;
  maxDeviationBps: number;
  nowMs?: number;
}): string | null {
  const nowMs = input.nowMs ?? Date.now();
  if (!input.estimate.complete || input.estimate.networkFeeQuote === null) {
    return input.estimate.reason ?? "fee_conversion_incomplete";
  }
  return validateXlmConversionRoute({
    quoteAssetId: input.quoteAssetId,
    quotePerXlm: input.estimate.conversionRateQuotePerXlm,
    conversionPath: input.estimate.conversionPath,
    referenceBook: input.referenceBook,
    probeXlm: input.probeXlm,
    maxBookAgeMs: input.maxBookAgeMs,
    maxDeviationBps: input.maxDeviationBps,
    nowMs,
  });
}

export function validateXlmConversionRoute(input: {
  quoteAssetId: string;
  quotePerXlm: string | null;
  conversionPath: string[] | null;
  referenceBook: OrderBookSnapshot | undefined;
  probeXlm: string;
  maxBookAgeMs: number;
  maxDeviationBps: number;
  nowMs?: number;
}): string | null {
  const nowMs = input.nowMs ?? Date.now();
  if (
    input.quotePerXlm === null
    || !new Big(input.quotePerXlm).gt(0)
    || input.conversionPath === null
    || input.conversionPath[0] !== "XLM"
    || input.conversionPath.at(-1) !== input.quoteAssetId
  ) {
    return "fee_conversion_path_asset_mismatch";
  }
  const book = input.referenceBook;
  if (!book) {
    return "fee_conversion_reference_book_unavailable";
  }
  if (book.baseAsset !== "XLM" || book.quoteAsset !== input.quoteAssetId) {
    return "fee_conversion_reference_pair_mismatch";
  }
  const integrityReasons = validateOrderBookIntegrity(book, input.maxBookAgeMs, nowMs);
  if (integrityReasons.length > 0) {
    return `fee_conversion_reference_${integrityReasons[0]}`;
  }

  const directEstimate = estimateExecutableVolume(book, "sell", input.probeXlm);
  if (!directEstimate.complete || directEstimate.averagePrice === null) {
    return "fee_conversion_reference_depth_insufficient";
  }
  const routeRate = new Big(input.quotePerXlm);
  const differenceBps = routeRate
    .minus(directEstimate.averagePrice)
    .abs()
    .div(directEstimate.averagePrice)
    .times(10_000);
  return differenceBps.gt(input.maxDeviationBps)
    ? "fee_conversion_route_implausible"
    : null;
}

export function invalidateFeeConversion(
  estimate: NetworkFeeEstimate,
  reason: string,
): NetworkFeeEstimate {
  return {
    ...estimate,
    complete: false,
    networkFeeQuote: null,
    reason,
  };
}

export function getXlmQuoteReferencePair(
  pairs: TradingPairConfig[],
  quoteAssetId: string,
): TradingPairConfig | undefined {
  return pairs.find((pair) =>
    pair.base.type === "native"
      && getPairId(pair) === `XLM/${quoteAssetId}`,
  );
}

export function isAssetVerified(
  database: Database.Database,
  assetId: string,
  nowMs: number,
  maxAgeMs: number,
): boolean {
  const record = database.prepare(`
    SELECT validation_status, validated_at_ms FROM assets WHERE asset_id = ?
  `).get(assetId) as { validation_status: string; validated_at_ms: number | null } | undefined;
  if (!record || record.validation_status !== "verified" || record.validated_at_ms === null) {
    return false;
  }
  const age = nowMs - record.validated_at_ms;
  return age >= 0 && age <= maxAgeMs;
}
