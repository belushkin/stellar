import { describe, expect, it } from "vitest";

import type { TradingPairConfig } from "../src/config/schema.js";
import {
  validateOrderBookIntegrity,
  validateXlmConversionRoute,
} from "../src/market-data/market-integrity.js";
import { normalizeOrderBook } from "../src/order-book/normalize.js";
import type { RawOrderBook } from "../src/order-book/types.js";

const pair: TradingPairConfig = {
  base: { type: "native" },
  quote: {
    type: "credit",
    code: "USDC",
    issuer: "GA24LJXFG73JGARIBG2GP6V5TNUUOS6BD23KOFCW3INLDY5KPKS7GACZ",
  },
};
const rawBook: RawOrderBook = {
  bids: [{ price_r: { n: 99, d: 100 }, amount: "5" }],
  asks: [{ price_r: { n: 101, d: 100 }, amount: "5" }],
};
const quoteAssetId = "USDC:GA24LJXFG73JGARIBG2GP6V5TNUUOS6BD23KOFCW3INLDY5KPKS7GACZ";

describe("validateOrderBookIntegrity", () => {
  it("rejects stale, one-sided, crossed, and locked books", () => {
    const nowMs = 10_000;
    const freshBook = normalizeOrderBook(rawBook, pair, nowMs);
    expect(validateOrderBookIntegrity(freshBook, 100, nowMs)).toEqual([]);
    expect(validateOrderBookIntegrity(freshBook, 100, nowMs + 101))
      .toContain("order_book_stale");

    const oneSided = normalizeOrderBook({ bids: rawBook.bids, asks: [] }, pair, nowMs);
    expect(validateOrderBookIntegrity(oneSided, 100, nowMs))
      .toContain("one_sided_order_book");

    const crossed = normalizeOrderBook({
      bids: [{ price_r: { n: 102, d: 100 }, amount: "5" }],
      asks: [{ price_r: { n: 101, d: 100 }, amount: "5" }],
    }, pair, nowMs);
    expect(validateOrderBookIntegrity(crossed, 100, nowMs))
      .toContain("order_book_crossed_or_locked");

    const locked = normalizeOrderBook({
      bids: [{ price_r: { n: 1, d: 1 }, amount: "5" }],
      asks: [{ price_r: { n: 1, d: 1 }, amount: "5" }],
    }, pair, nowMs);
    expect(validateOrderBookIntegrity(locked, 100, nowMs))
      .toContain("order_book_crossed_or_locked");
  });
});

describe("validateXlmConversionRoute", () => {
  const nowMs = 20_000;
  const book = normalizeOrderBook(rawBook, pair, nowMs);
  const baseInput = {
    quoteAssetId,
    quotePerXlm: "1",
    conversionPath: ["XLM", quoteAssetId],
    referenceBook: book,
    probeXlm: "1",
    maxBookAgeMs: 100,
    maxDeviationBps: 200,
    nowMs,
  };

  it("accepts a fresh, deep direct conversion within the configured deviation", () => {
    expect(validateXlmConversionRoute(baseInput)).toBeNull();
  });

  it("rejects path, pair, freshness, depth, and implausible-rate mismatches", () => {
    expect(validateXlmConversionRoute({
      ...baseInput,
      conversionPath: ["XLM", "OTHER:ISSUER"],
    })).toBe("fee_conversion_path_asset_mismatch");
    expect(validateXlmConversionRoute({
      ...baseInput,
      referenceBook: normalizeOrderBook(rawBook, {
        base: pair.quote,
        quote: { type: "native" },
      }, nowMs),
    })).toBe("fee_conversion_reference_pair_mismatch");
    expect(validateXlmConversionRoute({
      ...baseInput,
      referenceBook: normalizeOrderBook(rawBook, pair, nowMs - 1_000),
    })).toBe("fee_conversion_reference_order_book_stale");
    expect(validateXlmConversionRoute({
      ...baseInput,
      referenceBook: normalizeOrderBook({
        bids: [{ price_r: { n: 99, d: 100 }, amount: "0.5" }],
        asks: rawBook.asks,
      }, pair, nowMs),
    })).toBe("fee_conversion_reference_depth_insufficient");
    expect(validateXlmConversionRoute({
      ...baseInput,
      quotePerXlm: "1.2",
    })).toBe("fee_conversion_route_implausible");
  });
});
