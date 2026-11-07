import { describe, expect, it } from "vitest";

import type { TradingPairConfig } from "../src/config/schema.js";
import { normalizeOrderBook } from "../src/order-book/normalize.js";
import type { OrderBookSnapshot } from "../src/order-book/types.js";
import { PaperTradingEngine } from "../src/paper-trading/paper-trading-engine.js";
import { initializePaperPortfolio } from "../src/paper-trading/portfolio.js";
import { buildObservationReport } from "../src/reporting/observation-report.js";
import type { PassiveMakerSignal } from "../src/strategies/passive-maker.js";
import {
  backfillObservedTrades,
  completeExpiredHypotheticalOrders,
  openTradeStreamSession,
  recordHypotheticalOrder,
  recordObservedTrade,
  recordPortfolioValuation,
  recordTradeStreamGap,
  resolveTradeStreamGap,
  updateMaturedMarkouts,
} from "../src/observation/market-observation.js";
import { openDatabase } from "../src/storage/database.js";
import {
  recordMarketSnapshot,
  recordStrategyDecision,
  persistAssetValidation,
  registerTradingPair,
} from "../src/storage/market-store.js";

const pair: TradingPairConfig = {
  base: { type: "native" },
  quote: {
    type: "credit",
    code: "USDC",
    issuer: "GA24LJXFG73JGARIBG2GP6V5TNUUOS6BD23KOFCW3INLDY5KPKS7GACZ",
  },
};
const pairId = "XLM/USDC:GA24LJXFG73JGARIBG2GP6V5TNUUOS6BD23KOFCW3INLDY5KPKS7GACZ";
const quoteAssetId = "USDC:GA24LJXFG73JGARIBG2GP6V5TNUUOS6BD23KOFCW3INLDY5KPKS7GACZ";

function createBook(receivedAtMs: number, bidPrice = 98, bidAmount = "5"): OrderBookSnapshot {
  return normalizeOrderBook({
    bids: [{ price_r: { n: bidPrice, d: 100 }, amount: bidAmount }],
    asks: [{ price_r: { n: 101, d: 100 }, amount: "5" }],
  }, pair, receivedAtMs);
}

function createSignal(): PassiveMakerSignal {
  return {
    pairId,
    side: "buy",
    status: "positive",
    reasons: [],
    limitPrice: "0.98",
    requestedBaseAmount: "1",
    queueAheadBase: "5",
    expectedFilledBase: "1",
    expectedGrossPnlQuote: "0.02",
    networkFeeNature: "simulated_estimate",
    networkFeeXlm: "0.00001",
    networkFeeQuote: "0.01",
    adverseSelectionCostQuote: "0",
    inventoryRiskCostQuote: "0",
    otherModeledCostsQuote: "0",
    opportunityCostQuote: "0",
    expectedNetProfitQuote: "0.01",
    feeOperationCount: 2,
    feeRateMethod: "max_last_ledger_base_fee_and_fee_charged_p95",
    feeStatsLastLedger: "1",
    feeStatsFetchedAtMs: 1_000,
    feeConversionPath: ["XLM", quoteAssetId],
    feeConversionFetchedAtMs: 1_000,
    feeEstimateReason: null,
    displayedSpreadPercent: "2",
  };
}

function setup(nowMs = 1_000) {
  const database = openDatabase(":memory:");
  registerTradingPair(database, pair);
  const book = createBook(nowMs);
  const snapshotId = recordMarketSnapshot(database, book, []);
  const decisionId = recordStrategyDecision({
    database,
    pairId,
    snapshotId,
    side: "buy",
    status: "positive",
    reasons: [],
    evidence: undefined,
    feeEstimate: { networkFeeQuote: "0.01" },
    createdAtMs: nowMs,
  });
  const hypotheticalOrderId = recordHypotheticalOrder({
    database,
    decisionId,
    snapshotId,
    book,
    signal: createSignal(),
    cursor: "100",
    nowMs,
  });
  if (!hypotheticalOrderId) {
    throw new Error("Expected hypothetical order");
  }
  return { database, book, snapshotId, decisionId, hypotheticalOrderId };
}

function createTrade(input: {
  tradeId: string;
  cursor: string;
  occurredAtMs: number;
  priceNumerator?: string;
  baseAmount?: string;
  baseIsSeller?: boolean;
}): Parameters<typeof recordObservedTrade>[0]["trade"] {
  return {
    tradeId: input.tradeId,
    cursor: input.cursor,
    pairId,
    baseAmount: input.baseAmount ?? "6.5",
    priceNumerator: input.priceNumerator ?? "98",
    priceDenominator: "100",
    baseIsSeller: input.baseIsSeller ?? true,
    tradeType: "orderbook",
    occurredAtMs: input.occurredAtMs,
    receivedAtMs: input.occurredAtMs + 1,
  };
}

describe("market observation", () => {
  it("deduplicates public trades and only counts exact-price volume as queue evidence", () => {
    const fixture = setup();
    try {
      const trade = createTrade({
        tradeId: "exact-1",
        cursor: "101",
        occurredAtMs: 1_001,
      });
      expect(recordObservedTrade({
        database: fixture.database,
        trade,
        nowMs: 1_002,
      })).toEqual({ duplicate: false, validationReasons: [] });
      expect(recordObservedTrade({
        database: fixture.database,
        trade,
        nowMs: 1_003,
      }).duplicate).toBe(true);

      const evidence = fixture.database.prepare(`
        SELECT exact_price_volume_base, through_price_volume_base,
          estimated_fill_lower_base, estimated_fill_upper_base,
          quality_status
        FROM execution_evidence WHERE hypothetical_order_id = ?
      `).get(fixture.hypotheticalOrderId);
      expect(evidence).toEqual({
        exact_price_volume_base: "6.5",
        through_price_volume_base: "0",
        estimated_fill_lower_base: "0.5",
        estimated_fill_upper_base: "1",
        quality_status: "incomplete",
      });
      expect(fixture.database.prepare(`
        SELECT COUNT(*) AS count FROM markout_observations
        WHERE hypothetical_order_id = ?
      `).get(fixture.hypotheticalOrderId)).toEqual({ count: 4 });

      recordObservedTrade({
        database: fixture.database,
        trade: createTrade({
          tradeId: "through-1",
          cursor: "102",
          occurredAtMs: 1_004,
          priceNumerator: "97",
          baseAmount: "100",
        }),
        nowMs: 1_005,
      });
      const afterThrough = fixture.database.prepare(`
        SELECT exact_price_volume_base, through_price_volume_base,
          estimated_fill_lower_base, estimated_fill_upper_base
        FROM execution_evidence WHERE hypothetical_order_id = ?
      `).get(fixture.hypotheticalOrderId);
      expect(afterThrough).toEqual({
        exact_price_volume_base: "6.5",
        through_price_volume_base: "100",
        estimated_fill_lower_base: "0.5",
        estimated_fill_upper_base: "1",
      });
    } finally {
      fixture.database.close();
    }
  });

  it("quarantines incorrect timestamps without attributing them as executions", () => {
    const fixture = setup();
    try {
      const result = recordObservedTrade({
        database: fixture.database,
        trade: createTrade({
          tradeId: "future-trade",
          cursor: "101",
          occurredAtMs: 70_000,
        }),
        nowMs: 1_000,
      });

      expect(result.validationReasons).toContain("trade_timestamp_in_future");
      expect(fixture.database.prepare(`
        SELECT validation_status, validation_reasons_json FROM market_trades
        WHERE trade_id = 'future-trade'
      `).get()).toEqual({
        validation_status: "quarantined",
        validation_reasons_json: '["trade_timestamp_in_future"]',
      });
      expect(fixture.database.prepare(`
        SELECT observed_trade_count FROM execution_evidence
        WHERE hypothetical_order_id = ?
      `).get(fixture.hypotheticalOrderId)).toEqual({ observed_trade_count: 0 });
    } finally {
      fixture.database.close();
    }
  });

  it("quarantines a conflicting duplicate instead of advancing its cursor", () => {
    const fixture = setup();
    try {
      const original = createTrade({
        tradeId: "conflicted-trade",
        cursor: "101",
        occurredAtMs: 1_001,
      });
      recordObservedTrade({ database: fixture.database, trade: original, nowMs: 1_002 });
      const result = recordObservedTrade({
        database: fixture.database,
        trade: { ...original, cursor: "102", baseAmount: "7" },
        nowMs: 1_003,
      });
      expect(result.duplicate).toBe(true);
      expect(result.validationReasons).toContain("duplicate_trade_payload_conflict");
      expect(fixture.database.prepare(`
        SELECT validation_status FROM market_trades WHERE trade_id = ?
      `).get(original.tradeId)).toEqual({ validation_status: "quarantined" });
      expect(fixture.database.prepare(`
        SELECT trade_cursor FROM stream_cursors WHERE pair_id = ?
      `).get(pairId)).toEqual({ trade_cursor: "101" });
      expect(fixture.database.prepare(`
        SELECT status FROM markout_observations
        WHERE estimated_fill_trade_id = ?
      `).all(original.tradeId)).toEqual([
        { status: "invalid" },
        { status: "invalid" },
        { status: "invalid" },
        { status: "invalid" },
      ]);
    } finally {
      fixture.database.close();
    }
  });

  it("records unresolved stream gaps and closes them only after durable backfill", () => {
    const fixture = setup();
    try {
      const sessionId = openTradeStreamSession({
        database: fixture.database,
        pairId,
        source: "horizon_sse",
        cursor: "100",
        nowMs: 1_100,
      });

      const gapId = recordTradeStreamGap({
        database: fixture.database,
        pairId,
        sessionId,
        source: "horizon_sse",
        fromCursor: "100",
        reason: "connection_reset",
        nowMs: 1_200,
      });
      expect(fixture.database.prepare(`
        SELECT status FROM market_data_gaps WHERE gap_id = ?
      `).get(gapId)).toEqual({ status: "open" });

      recordObservedTrade({
        database: fixture.database,
        trade: createTrade({
          tradeId: "recovered",
          cursor: "101",
          occurredAtMs: 1_300,
        }),
        nowMs: 1_301,
      });
      resolveTradeStreamGap({
        database: fixture.database,
        gapId,
        toCursor: "101",
        recoveredEventCount: 1,
        nowMs: 1_400,
      });
      expect(fixture.database.prepare(`
        SELECT status, recovered_event_count FROM market_data_gaps WHERE gap_id = ?
      `).get(gapId)).toEqual({ status: "resolved", recovered_event_count: 1 });
    } finally {
      fixture.database.close();
    }
  });

  it("backfills from the committed cursor before resolving a reconnect gap", async () => {
    const fixture = setup();
    try {
      const sessionId = openTradeStreamSession({
        database: fixture.database,
        pairId,
        source: "horizon_sse",
        cursor: "100",
        nowMs: 1_100,
      });
      const gapId = recordTradeStreamGap({
        database: fixture.database,
        pairId,
        sessionId,
        source: "horizon_sse",
        fromCursor: "100",
        reason: "connection_reset",
        nowMs: 1_200,
      });
      const result = await backfillObservedTrades({
        database: fixture.database,
        source: {
          catchUp: async (_pair, cursor, onTrade) => {
            expect(cursor).toBe("100");
            onTrade(createTrade({
              tradeId: "reconnect-recovered",
              cursor: "101",
              occurredAtMs: 1_300,
            }));
            return { count: 1, lastCursor: "101" };
          },
        },
        pair,
        pairId,
        sessionId,
        cursor: "100",
        nowMs: 1_400,
      });
      expect(result).toEqual({ count: 1, lastCursor: "101" });
      expect(fixture.database.prepare(`
        SELECT status, recovered_event_count FROM market_data_gaps WHERE gap_id = ?
      `).get(gapId)).toEqual({ status: "resolved", recovered_event_count: 1 });
      expect(fixture.database.prepare(`
        SELECT source, cursor FROM market_trades WHERE trade_id = 'reconnect-recovered'
      `).get()).toEqual({ source: "horizon_rest_backfill", cursor: "101" });
      expect(fixture.database.prepare(`
        SELECT trade_cursor FROM stream_cursors WHERE pair_id = ?
      `).get(pairId)).toEqual({ trade_cursor: "101" });

      const failedGapId = recordTradeStreamGap({
        database: fixture.database,
        pairId,
        sessionId,
        source: "horizon_sse",
        fromCursor: "101",
        reason: "second_disconnect",
        nowMs: 1_500,
      });
      await expect(backfillObservedTrades({
        database: fixture.database,
        source: {
          catchUp: async () => {
            throw new Error("Horizon unavailable");
          },
        },
        pair,
        pairId,
        sessionId,
        cursor: "101",
        nowMs: 1_600,
      })).rejects.toThrow("Horizon unavailable");
      expect(fixture.database.prepare(`
        SELECT status, error FROM market_data_gaps WHERE gap_id = ?
      `).get(failedGapId)).toEqual({
        status: "open",
        error: "Horizon unavailable",
      });
    } finally {
      fixture.database.close();
    }
  });

  it("reports evidence bounds and keeps performance denominated by pair and strategy", () => {
    const fixture = setup();
    try {
      recordObservedTrade({
        database: fixture.database,
        trade: createTrade({
          tradeId: "report-fill",
          cursor: "101",
          occurredAtMs: 1_001,
        }),
        nowMs: 1_002,
      });

      const report = buildObservationReport({
        database: fixture.database,
        portfolioId: "unseeded",
        nowMs: 2_000,
      });
      expect(report.observationMode).toBe(true);
      expect(report.signals.generated).toBe(1);
      expect(report.executionEvidence.estimatedFillRateBounds).toEqual({
        lower: "0.5",
        upper: "1",
      });
      expect(report.executionEvidence.observedTradeVolumeIsNotProofOfOurExecution).toBe(true);
      expect(report.performanceByPairAndStrategy).toEqual([{
        pairId,
        strategyId: "passive_maker",
        scenarioCount: 1,
        estimatedLowerFillBase: "0.5",
        estimatedUpperFillBase: "1",
        completedMarkouts: 0,
        grossMarkoutPnlQuote: "0",
        netMarkoutPnlQuote: "0",
      }]);
    } finally {
      fixture.database.close();
    }
  });

  it("only calls a no-fill window complete after its observation horizon and gap check", () => {
    const fixture = setup();
    try {
      recordObservedTrade({
        database: fixture.database,
        trade: createTrade({
          tradeId: "after-window",
          cursor: "101",
          occurredAtMs: 3_601_001,
        }),
        nowMs: 3_601_002,
      });
      expect(fixture.database.prepare(`
        SELECT observed_trade_count FROM execution_evidence
        WHERE hypothetical_order_id = ?
      `).get(fixture.hypotheticalOrderId)).toEqual({ observed_trade_count: 0 });
      expect(completeExpiredHypotheticalOrders({
        database: fixture.database,
        pairId,
        observedAtMs: 3_601_000,
        nowMs: 3_601_001,
      })).toEqual({ complete: 1, incomplete: 0 });
      expect(fixture.database.prepare(`
        SELECT status FROM hypothetical_orders WHERE hypothetical_order_id = ?
      `).get(fixture.hypotheticalOrderId)).toEqual({ status: "complete" });
      expect(fixture.database.prepare(`
        SELECT estimated_fill_probability_lower, estimated_fill_probability_upper
        FROM execution_evidence WHERE hypothetical_order_id = ?
      `).get(fixture.hypotheticalOrderId)).toEqual({
        estimated_fill_probability_lower: "0",
        estimated_fill_probability_upper: "0",
      });

      const gapFixture = setup();
      try {
        const sessionId = openTradeStreamSession({
          database: gapFixture.database,
          pairId,
          source: "horizon_sse",
          cursor: "100",
          nowMs: 1_100,
        });
        recordTradeStreamGap({
          database: gapFixture.database,
          pairId,
          sessionId,
          source: "horizon_sse",
          fromCursor: "100",
          reason: "unresolved_stream_gap",
          nowMs: 1_200,
        });
        expect(completeExpiredHypotheticalOrders({
          database: gapFixture.database,
          pairId,
          observedAtMs: 3_601_000,
          nowMs: 3_601_001,
        })).toEqual({ complete: 0, incomplete: 1 });
        expect(gapFixture.database.prepare(`
          SELECT status FROM hypothetical_orders WHERE hypothetical_order_id = ?
        `).get(gapFixture.hypotheticalOrderId)).toEqual({ status: "incomplete" });
      } finally {
        gapFixture.database.close();
      }
    } finally {
      fixture.database.close();
    }
  });

  it("uses executable liquidation depth and leaves markouts incomplete when depth is missing", () => {
    const fixture = setup();
    try {
      recordObservedTrade({
        database: fixture.database,
        trade: createTrade({
          tradeId: "markout-fill",
          cursor: "101",
          occurredAtMs: 1_001,
        }),
        nowMs: 1_002,
      });
      const markoutBook = createBook(61_001, 97, "1");
      const markoutSnapshotId = recordMarketSnapshot(fixture.database, markoutBook, []);
      expect(updateMaturedMarkouts({
        database: fixture.database,
        book: markoutBook,
        snapshotId: markoutSnapshotId,
        maxOrderBookAgeMs: 10_000,
        nowMs: 61_002,
      })).toBe(1);
      expect(fixture.database.prepare(`
        SELECT status, markout_gross_quote, markout_net_quote
        FROM markout_observations
        WHERE hypothetical_order_id = ? AND horizon_minutes = 1
      `).get(fixture.hypotheticalOrderId)).toEqual({
        status: "complete",
        markout_gross_quote: "-0.005",
        markout_net_quote: "-0.01",
      });
      expect(fixture.database.prepare(`
        SELECT status FROM markout_observations
        WHERE hypothetical_order_id = ? AND horizon_minutes = 5
      `).get(fixture.hypotheticalOrderId)).toEqual({ status: "pending" });
    } finally {
      fixture.database.close();
    }
  });

  it("retries a markout after a stale snapshot instead of recording a false zero", () => {
    const fixture = setup();
    try {
      recordObservedTrade({
        database: fixture.database,
        trade: createTrade({
          tradeId: "stale-markout-fill",
          cursor: "101",
          occurredAtMs: 1_001,
        }),
        nowMs: 1_002,
      });
      const staleBook = createBook(61_001);
      const staleSnapshotId = recordMarketSnapshot(fixture.database, staleBook, []);
      updateMaturedMarkouts({
        database: fixture.database,
        book: staleBook,
        snapshotId: staleSnapshotId,
        maxOrderBookAgeMs: 10_000,
        nowMs: 80_000,
      });
      expect(fixture.database.prepare(`
        SELECT status FROM markout_observations
        WHERE hypothetical_order_id = ? AND horizon_minutes = 1
      `).get(fixture.hypotheticalOrderId)).toEqual({ status: "pending" });

      const freshBook = createBook(81_000);
      const freshSnapshotId = recordMarketSnapshot(fixture.database, freshBook, []);
      updateMaturedMarkouts({
        database: fixture.database,
        book: freshBook,
        snapshotId: freshSnapshotId,
        maxOrderBookAgeMs: 10_000,
        nowMs: 81_001,
      });
      expect(fixture.database.prepare(`
        SELECT status FROM markout_observations
        WHERE hypothetical_order_id = ? AND horizon_minutes = 1
      `).get(fixture.hypotheticalOrderId)).toEqual({ status: "complete" });
    } finally {
      fixture.database.close();
    }
  });

  it("fails closed when inventory cannot be valued from a fresh executable book", () => {
    const fixture = setup();
    try {
      initializePaperPortfolio({
        database: fixture.database,
        portfolioId: "valuation-test",
        initialBalances: { native: "1", [quoteAssetId]: "10" },
        nowMs: 1_000,
      });
      fixture.database.prepare(`
        INSERT INTO paper_lots (
          lot_id, portfolio_id, pair_id, base_asset_id, quote_asset_id,
          original_base, remaining_base, unit_cost_quote, created_at_ms
        ) VALUES ('lot-1', 'valuation-test', ?, 'native', ?, '1', '1', '1', 1)
      `).run(pairId, quoteAssetId);

      const valuation = recordPortfolioValuation({
        database: fixture.database,
        portfolioId: "valuation-test",
        pair,
        book: undefined,
        snapshotId: undefined,
        maxOrderBookAgeMs: 10_000,
        nowMs: 2_000,
      });
      expect(valuation.status).toBe("incomplete");
      expect(valuation.dailyNetPnlQuote).toBeNull();
      expect(valuation.reasons).toContain("conservative_liquidation_book_unavailable_or_stale");
      const stale = recordPortfolioValuation({
        database: fixture.database,
        portfolioId: "valuation-test",
        pair,
        book: createBook(1_000),
        snapshotId: undefined,
        maxOrderBookAgeMs: 100,
        nowMs: 2_000,
      });
      expect(stale.status).toBe("incomplete");
      expect(stale.dailyNetPnlQuote).toBeNull();
      expect(stale.reasons).toContain("conservative_liquidation_book_unavailable_or_stale");
    } finally {
      fixture.database.close();
    }
  });

  it("blocks paper order validation when conservative unrealized P&L breaches the daily limit", () => {
    const nowMs = 10_000;
    const database = openDatabase(":memory:");
    try {
      const registeredPairId = registerTradingPair(database, pair);
      for (const asset of [pair.base, pair.quote]) {
        persistAssetValidation({
          database,
          asset,
          status: "verified",
          homeDomain: asset.type === "credit" ? "example.org" : null,
          validatedAtMs: nowMs,
          error: null,
        });
      }
      initializePaperPortfolio({
        database,
        portfolioId: "risk-test",
        initialBalances: { native: "1", [quoteAssetId]: "100" },
        nowMs,
      });
      database.prepare(`
        INSERT INTO paper_lots (
          lot_id, portfolio_id, pair_id, base_asset_id, quote_asset_id,
          original_base, remaining_base, unit_cost_quote, created_at_ms
        ) VALUES ('opening-lot', 'risk-test', ?, 'native', ?, '1', '1', '0.99', ?)
      `).run(registeredPairId, quoteAssetId, nowMs);
      const firstBook = normalizeOrderBook({
        bids: [{ price_r: { n: 99, d: 100 }, amount: "5" }],
        asks: [{ price_r: { n: 101, d: 100 }, amount: "5" }],
      }, pair, nowMs);
      const firstSnapshotId = recordMarketSnapshot(database, firstBook, []);
      const firstDecisionId = recordStrategyDecision({
        database,
        pairId: registeredPairId,
        snapshotId: firstSnapshotId,
        side: "buy",
        status: "positive",
        reasons: [],
        evidence: undefined,
        feeEstimate: {},
        createdAtMs: nowMs,
      });
      const engine = new PaperTradingEngine(database, {
        maxOrderBookAgeMs: 10_000,
        maximumMakerOrderBase: "2",
        maximumInventoryBase: "10",
        makerReplacementsPerOrder: 0,
        feeConversionProbeXlm: "1",
        feeConversionMaxDeviationBps: 200,
        assetValidationMaxAgeMs: 100_000,
        paperEmergencyStop: false,
        paperMaxDailyLossByQuote: { [quoteAssetId]: "0.1" },
      });
      const fees = {
        operationFeeStroops: "100",
        quoteAssetId,
        quotePerXlm: "1",
        conversionPath: ["XLM", quoteAssetId],
        conversionSnapshotId: firstSnapshotId,
        referenceBook: firstBook,
      };
      const firstOrder = engine.submitOrder({
        portfolioId: "risk-test",
        pair,
        decisionId: firstDecisionId,
        clientOrderKey: "risk-order-1",
        orderType: "limit",
        side: "buy",
        limitPrice: "0.99",
        baseAmount: "1",
        book: firstBook,
        snapshotId: firstSnapshotId,
        fees,
        nowMs,
      });
      expect(firstOrder.status).toBe("open");
      engine.processTrade({
        trade: createTrade({
          tradeId: "risk-fill",
          cursor: "201",
          occurredAtMs: nowMs + 1,
          priceNumerator: "99",
          baseAmount: "6",
        }),
        book: firstBook,
        snapshotId: firstSnapshotId,
        nowMs: nowMs + 1,
      });
      const lossBook = normalizeOrderBook({
        bids: [{ price_r: { n: 50, d: 100 }, amount: "5" }],
        asks: [{ price_r: { n: 51, d: 100 }, amount: "5" }],
      }, pair, nowMs + 2);
      const lossSnapshotId = recordMarketSnapshot(database, lossBook, []);
      const lossDecisionId = recordStrategyDecision({
        database,
        pairId: registeredPairId,
        snapshotId: lossSnapshotId,
        side: "buy",
        status: "positive",
        reasons: [],
        evidence: undefined,
        feeEstimate: {},
        createdAtMs: nowMs + 2,
      });
      const blocked = engine.submitOrder({
        portfolioId: "risk-test",
        pair,
        decisionId: lossDecisionId,
        clientOrderKey: "risk-order-2",
        orderType: "limit",
        side: "buy",
        limitPrice: "0.5",
        baseAmount: "1",
        book: lossBook,
        snapshotId: lossSnapshotId,
        fees: {
          ...fees,
          conversionSnapshotId: firstSnapshotId,
          referenceBook: firstBook,
        },
        nowMs: nowMs + 2,
      });
      expect(blocked.status).toBe("rejected");
      expect(blocked.reason).toBe("maximum_daily_simulated_loss_reached");
    } finally {
      database.close();
    }
  });
});
