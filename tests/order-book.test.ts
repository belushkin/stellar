import { describe, expect, it } from "vitest";

import type { TradingPairConfig } from "../src/config/schema.js";
import { estimateExecutableVolume } from "../src/order-book/executable-volume.js";
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
  bids: [
    { price_r: { n: 1, d: 2 }, amount: "2.0000000" },
    { price_r: { n: 4, d: 5 }, amount: "1.0000000" },
  ],
  asks: [
    { price_r: { n: 3, d: 2 }, amount: "1.0000000" },
    { price_r: { n: 1, d: 1 }, amount: "0.5000000" },
  ],
};

describe("normalizeOrderBook", () => {
  it("normalizes exact prices, sorts levels, and calculates depth and spread", () => {
    const book = normalizeOrderBook(rawBook, pair, 1_000);

    expect(book.pairId).toBe(
      "XLM/USDC:GA24LJXFG73JGARIBG2GP6V5TNUUOS6BD23KOFCW3INLDY5KPKS7GACZ",
    );
    expect(book.receivedAtMs).toBe(1_000);
    expect(book.latestLedger).toBeNull();
    expect(book.bids.map((level) => level.price)).toEqual(["0.8", "0.5"]);
    expect(book.asks.map((level) => level.price)).toEqual(["1", "1.5"]);
    expect(book.bestBid).toBe("0.8");
    expect(book.bestAsk).toBe("1");
    expect(book.spreadAbsolute).toBe("0.2");
    expect(book.spreadPercent).toBe("22.22222222222222222222222222222222222222");
    expect(book.bidDepth).toEqual({ baseAmount: "3", quoteAmount: "1.8" });
    expect(book.askDepth).toEqual({ baseAmount: "1.5", quoteAmount: "2" });
  });

  it("handles empty or one-sided books without inventing a spread", () => {
    const book = normalizeOrderBook({ bids: [], asks: rawBook.asks }, pair, 1_000);

    expect(book.bestBid).toBeNull();
    expect(book.spreadAbsolute).toBeNull();
    expect(book.spreadPercent).toBeNull();
    expect(book.bidDepth).toEqual({ baseAmount: "0", quoteAmount: "0" });
  });

  it("rejects malformed, zero, or unsafe levels", () => {
    expect(() => normalizeOrderBook({
      bids: [{ price_r: { n: 1, d: 0 }, amount: "1" }],
      asks: [],
    }, pair)).toThrow("positive safe integers");

    expect(() => normalizeOrderBook({
      bids: [{ price_r: { n: 1, d: 1 }, amount: "0" }],
      asks: [],
    }, pair)).toThrow("must be positive");
  });
});

describe("estimateExecutableVolume", () => {
  const book = normalizeOrderBook(rawBook, pair, 1_000);

  it("estimates buy VWAP and adverse slippage across ask levels", () => {
    const estimate = estimateExecutableVolume(book, "buy", "0.75");

    expect(estimate.complete).toBe(true);
    expect(estimate.filledBaseAmount).toBe("0.75");
    expect(estimate.remainingBaseAmount).toBe("0");
    expect(estimate.quoteAmount).toBe("0.875");
    expect(estimate.averagePrice).toBe("1.1666666666666666666666666666666666666666");
    expect(estimate.slippagePercent).toBe("16.66666666666666666666666666666666666666");
  });

  it("reports partial sell liquidity and slippage without extrapolating depth", () => {
    const estimate = estimateExecutableVolume(book, "sell", "5");

    expect(estimate.complete).toBe(false);
    expect(estimate.filledBaseAmount).toBe("3");
    expect(estimate.remainingBaseAmount).toBe("2");
    expect(estimate.quoteAmount).toBe("1.8");
    expect(estimate.averagePrice).toBe("0.6");
    expect(estimate.slippagePercent).toBe("25");
  });

  it("rejects nonpositive order sizes", () => {
    expect(() => estimateExecutableVolume(book, "buy", "0")).toThrow(
      "Requested base amount must be positive",
    );
  });
});
