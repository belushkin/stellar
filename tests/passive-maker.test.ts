import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/schema.js";
import type { NetworkFeeEstimate } from "../src/market-data/fee-estimator.js";
import { getPairId, normalizeOrderBook } from "../src/order-book/normalize.js";
import type { RawOrderBook } from "../src/order-book/types.js";
import {
  evaluatePassiveMakerSignal,
  type MakerModelEvidence,
  type MakerPortfolioState,
} from "../src/strategies/passive-maker.js";

const pair = {
  base: { type: "native" },
  quote: {
    type: "credit",
    code: "USDC",
    issuer: "GA24LJXFG73JGARIBG2GP6V5TNUUOS6BD23KOFCW3INLDY5KPKS7GACZ",
  },
} as const;
const pairId = getPairId(pair);

const rawBook: RawOrderBook = {
  bids: [{ price_r: { n: 99, d: 100 }, amount: "5" }],
  asks: [{ price_r: { n: 101, d: 100 }, amount: "5" }],
};

const fees: NetworkFeeEstimate = {
  complete: true,
  operationCount: 4,
  quoteAssetId: "USDC:GA24LJXFG73JGARIBG2GP6V5TNUUOS6BD23KOFCW3INLDY5KPKS7GACZ",
  nature: "simulated_estimate",
  feeRateMethod: "max_last_ledger_base_fee_and_fee_charged_p95",
  operationFeeStroops: "100",
  totalFeeStroops: "400",
  networkFeeXlm: "0.00004",
  networkFeeQuote: "0.00004",
  conversionRateQuotePerXlm: "1",
  feeStatsLastLedger: "123",
  feeStatsFetchedAtMs: 1_000,
  conversionPath: ["XLM", "USDC:GA24LJXFG73JGARIBG2GP6V5TNUUOS6BD23KOFCW3INLDY5KPKS7GACZ"],
  conversionFetchedAtMs: 1_000,
  reason: null,
  error: null,
};

const evidence: MakerModelEvidence = {
  pairId,
  side: "buy",
  measuredAtMs: 1_000,
  sampleCount: 100,
  queueModel: "conservative_trade_through",
  expectedFillFraction: "0.5",
  expectedGrossPnlPerFilledBaseQuote: "0.1",
  adverseSelectionCostPerFilledBaseQuote: "0.01",
  otherModeledCostPerFilledBaseQuote: "0.005",
  opportunityCostPerFilledBaseQuote: "0.005",
};

const portfolio: MakerPortfolioState = {
  pairId,
  baseInventory: "0",
  availableBase: "0",
  availableQuote: "100",
};

function makeSignal(overrides: {
  side?: "buy" | "sell";
  model?: MakerModelEvidence | undefined;
  fees?: NetworkFeeEstimate;
  portfolio?: MakerPortfolioState | undefined;
  nowMs?: number;
} = {}) {
  const config = loadConfig({});
  return evaluatePassiveMakerSignal({
    book: normalizeOrderBook(rawBook, pair, 1_000),
    pair,
    side: overrides.side ?? "buy",
    portfolio: "portfolio" in overrides ? overrides.portfolio : portfolio,
    evidence: "model" in overrides ? overrides.model : evidence,
    fees: overrides.fees ?? fees,
    config,
    nowMs: overrides.nowMs ?? 1_000,
  });
}

describe("evaluatePassiveMakerSignal", () => {
  it("only reports positive expected net profit from evidence and complete dynamic fees", () => {
    const signal = makeSignal();

    expect(signal.status).toBe("positive");
    expect(signal.limitPrice).toBe("0.99");
    expect(signal.queueAheadBase).toBe("5");
    expect(signal.expectedFilledBase).toBe("0.5");
    expect(signal.expectedGrossPnlQuote).toBe("0.05");
    expect(signal.networkFeeXlm).toBe("0.00004");
    expect(signal.networkFeeQuote).toBe("0.00004");
    expect(signal.adverseSelectionCostQuote).toBe("0.005");
    expect(signal.inventoryRiskCostQuote).toBe("0.00125");
    expect(signal.otherModeledCostsQuote).toBe("0.0025");
    expect(signal.opportunityCostQuote).toBe("0.0025");
    expect(signal.expectedNetProfitQuote).toBe("0.03871");
  });

  it("fails closed when fill/markout evidence or fee conversion is missing", () => {
    const missingModel = makeSignal({ model: undefined });
    expect(missingModel.status).toBe("insufficient_data");
    expect(missingModel.expectedNetProfitQuote).toBeNull();
    expect(missingModel.reasons).toContain(
      "passive_fill_and_markout_evidence_unavailable",
    );

    const incompleteFees = makeSignal({
      fees: { ...fees, complete: false, networkFeeQuote: null },
    });
    expect(incompleteFees.status).toBe("insufficient_data");
    expect(incompleteFees.expectedNetProfitQuote).toBeNull();
    expect(incompleteFees.reasons).toContain("network_fee_conversion_incomplete");
  });

  it("never treats a displayed spread as expected profit without empirical model output", () => {
    const signal = makeSignal({
      model: {
        ...evidence,
        expectedGrossPnlPerFilledBaseQuote: "0",
      },
    });

    expect(signal.displayedSpreadPercent).not.toBeNull();
    expect(signal.status).toBe("rejected");
    expect(signal.expectedNetProfitQuote).toBe("-0.01129");
    expect(signal.reasons).toContain("expected_net_profit_below_minimum");
  });

  it("rejects orders that exceed available inventory", () => {
    const signal = makeSignal({
      side: "sell",
      portfolio: { pairId, baseInventory: "0.5", availableBase: "0.5", availableQuote: "100" },
      model: { ...evidence, side: "sell" },
    });
    expect(signal.status).toBe("rejected");
    expect(signal.reasons).toContain("insufficient_base_inventory");
  });

  it("fails closed when evidence or portfolio belongs to a different pair", () => {
    const wrongEvidence = makeSignal({
      model: { ...evidence, pairId: "other-pair" },
    });
    expect(wrongEvidence.status).toBe("insufficient_data");
    expect(wrongEvidence.reasons).toContain(
      "passive_model_evidence_stale_or_incompatible",
    );

    const wrongPortfolio = makeSignal({
      portfolio: { ...portfolio, pairId: "other-pair" },
    });
    expect(wrongPortfolio.status).toBe("insufficient_data");
    expect(wrongPortfolio.reasons).toContain("portfolio_pair_mismatch");

    const wrongSide = makeSignal({
      model: { ...evidence, side: "sell" },
    });
    expect(wrongSide.status).toBe("insufficient_data");
    expect(wrongSide.reasons).toContain(
      "passive_model_evidence_stale_or_incompatible",
    );
  });

  it("rejects stale books and stale model data", () => {
    const staleEvidence = { ...evidence, measuredAtMs: 0 };
    const signal = makeSignal({ model: staleEvidence, nowMs: 3_600_001 });

    expect(signal.status).toBe("insufficient_data");
    expect(signal.reasons).toContain("order_book_stale");
    expect(signal.reasons).toContain("passive_model_evidence_stale_or_incompatible");
  });

  it("fails closed for crossed or locked books", () => {
    const crossedBook = normalizeOrderBook({
      bids: [{ price_r: { n: 102, d: 100 }, amount: "5" }],
      asks: [{ price_r: { n: 101, d: 100 }, amount: "5" }],
    }, pair, 1_000);
    const signal = evaluatePassiveMakerSignal({
      book: crossedBook,
      pair,
      side: "buy",
      portfolio,
      evidence,
      fees,
      config: loadConfig({}),
      nowMs: 1_000,
    });

    expect(signal.status).toBe("insufficient_data");
    expect(signal.expectedNetProfitQuote).toBeNull();
    expect(signal.reasons).toContain("order_book_crossed_or_locked");
  });
});
