import { describe, expect, it } from "vitest";

import type { TradingPairConfig } from "../src/config/schema.js";
import { normalizeOrderBook } from "../src/order-book/normalize.js";
import type { RawOrderBook } from "../src/order-book/types.js";
import { estimateConservativePassiveFill } from "../src/strategies/passive-fill-model.js";

const pair: TradingPairConfig = {
  base: { type: "native" },
  quote: { type: "credit", code: "USDC", issuer: "GA24LJXFG73JGARIBG2GP6V5TNUUOS6BD23KOFCW3INLDY5KPKS7GACZ" },
};

const rawBook: RawOrderBook = {
  bids: [{ price_r: { n: 99, d: 100 }, amount: "5" }],
  asks: [{ price_r: { n: 101, d: 100 }, amount: "5" }],
};

describe("estimateConservativePassiveFill", () => {
  const book = normalizeOrderBook(rawBook, pair, 1_000);

  it("does not fill on price touch or an ineligible trade", () => {
    const estimate = estimateConservativePassiveFill({
      bookAtPlacement: book,
      side: "buy",
      orderBaseAmount: "2",
      placedAtMs: 1_000,
      trades: [
        {
          pairId: book.pairId,
          baseAmount: "100",
          priceNumerator: "99",
          priceDenominator: "100",
          baseIsSeller: true,
          tradeType: "liquidity_pool",
          occurredAtMs: 1_001,
        },
        {
          pairId: book.pairId,
          baseAmount: "100",
          priceNumerator: "99",
          priceDenominator: "100",
          baseIsSeller: false,
          tradeType: "orderbook",
          occurredAtMs: 1_002,
        },
      ],
    });

    expect(estimate.queueAheadAtPlacementBase).toBe("5");
    expect(estimate.eligibleTradeVolumeBase).toBe("0");
    expect(estimate.filledBase).toBe("0");
    expect(estimate.remainingBase).toBe("2");
  });

  it("subtracts the full displayed queue before recording a partial fill", () => {
    const estimate = estimateConservativePassiveFill({
      bookAtPlacement: book,
      side: "buy",
      orderBaseAmount: "2",
      placedAtMs: 1_000,
      trades: [{
        pairId: book.pairId,
        baseAmount: "5.5",
        priceNumerator: "98",
        priceDenominator: "100",
        baseIsSeller: true,
        tradeType: "orderbook",
        occurredAtMs: 1_001,
      }],
    });

    expect(estimate.eligibleTradeVolumeBase).toBe("5.5");
    expect(estimate.queueConsumedBase).toBe("5");
    expect(estimate.filledBase).toBe("0.5");
    expect(estimate.remainingBase).toBe("1.5");
    expect(estimate.complete).toBe(false);
  });

  it("models sell-side queue consumption only from eligible buyer-initiated trades", () => {
    const estimate = estimateConservativePassiveFill({
      bookAtPlacement: book,
      side: "sell",
      orderBaseAmount: "1",
      placedAtMs: 1_000,
      trades: [{
        pairId: book.pairId,
        baseAmount: "6",
        priceNumerator: "102",
        priceDenominator: "100",
        baseIsSeller: false,
        tradeType: "orderbook",
        occurredAtMs: 1_001,
      }],
    });

    expect(estimate.queueAheadAtPlacementBase).toBe("5");
    expect(estimate.filledBase).toBe("1");
    expect(estimate.complete).toBe(true);
  });
});
