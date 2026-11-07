import { describe, expect, it } from "vitest";

import { getPairId } from "../src/order-book/normalize.js";
import { buildMakerModelEvidence } from "../src/strategies/maker-evidence.js";
const pairId = getPairId({
  base: { type: "native" },
  quote: {
    type: "credit",
    code: "USDC",
    issuer: "GA24LJXFG73JGARIBG2GP6V5TNUUOS6BD23KOFCW3INLDY5KPKS7GACZ",
  },
});

describe("buildMakerModelEvidence", () => {
  it("uses partial fill observations, queue-aware fill ratios, and post-fill markouts", () => {
    const evidence = buildMakerModelEvidence([
      {
        side: "buy",
        requestedBaseAmount: "2",
        fills: [{
          baseAmount: "1",
          limitPrice: "0.99",
          midpointAtFill: "1",
          midpointAfterMarkout: "0.99",
          otherModeledCostPerBaseQuote: "0.001",
          opportunityCostPerBaseQuote: "0.002",
        }],
      },
      {
        side: "buy",
        requestedBaseAmount: "1",
        fills: [{
          baseAmount: "0.5",
          limitPrice: "0.99",
          midpointAtFill: "0.98",
          midpointAfterMarkout: "0.99",
          otherModeledCostPerBaseQuote: "0.003",
          opportunityCostPerBaseQuote: "0.004",
        }],
      },
    ], pairId, 1_000);

    expect(evidence).toMatchObject({
      pairId,
      side: "buy",
      measuredAtMs: 1_000,
      sampleCount: 2,
      queueModel: "conservative_trade_through",
      expectedFillFraction: "0.5",
      expectedGrossPnlPerFilledBaseQuote: "0.0033333333333333333333333333333333333333",
      adverseSelectionCostPerFilledBaseQuote: "0.0066666666666666666666666666666666666666",
      otherModeledCostPerFilledBaseQuote: "0.0016666666666666666666666666666666666666",
      opportunityCostPerFilledBaseQuote: "0.0026666666666666666666666666666666666666",
    });
  });

  it("returns no evidence without real passive fills", () => {
    expect(buildMakerModelEvidence([
      { side: "sell", requestedBaseAmount: "1", fills: [] },
    ], pairId, 1_000)).toBeUndefined();
  });

  it("rejects impossible fills above submitted size", () => {
    expect(() => buildMakerModelEvidence([{
      side: "buy",
      requestedBaseAmount: "1",
      fills: [{
        baseAmount: "1.1",
        limitPrice: "1",
        midpointAtFill: "1.1",
        midpointAfterMarkout: "1.1",
        otherModeledCostPerBaseQuote: "0",
        opportunityCostPerBaseQuote: "0",
      }],
    }], pairId, 1_000)).toThrow("Observed fills exceed");
  });

  it("rejects mixed-side evidence samples", () => {
    expect(() => buildMakerModelEvidence([
      { side: "buy", requestedBaseAmount: "1", fills: [] },
      { side: "sell", requestedBaseAmount: "1", fills: [] },
    ], pairId, 1_000)).toThrow("single passive side");
  });
});
