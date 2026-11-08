import { describe, expect, it } from "vitest";

import { HistoricalReplayEngine } from "../src/observation/historical-replay-engine.js";
import { buildObservationReport } from "../src/reporting/observation-report.js";
import { openDatabase } from "../src/storage/database.js";
import type { OrderBookSnapshot } from "../src/order-book/types.js";

const PAIR_ID = "XLM/USD:ISSUER";
const PLACEMENT_AT = 1_700_000_000_000;

function makeBook(
  receivedAtMs: number,
  bids: Array<{ price: string; amount: string }> = [{ price: "1", amount: "5" }],
  asks: Array<{ price: string; amount: string }> = [{ price: "1.1", amount: "5" }],
): OrderBookSnapshot {
  return {
    pairId: PAIR_ID,
    baseAsset: "XLM",
    quoteAsset: "USD:ISSUER",
    bids,
    asks,
    receivedAt: new Date(receivedAtMs).toISOString(),
    receivedAtMs,
    latestLedger: null,
    bestBid: bids[0]?.price ?? null,
    bestAsk: asks[0]?.price ?? null,
    spreadAbsolute: "0.1",
    spreadPercent: "9.52",
    bidDepth: { baseAmount: "5", quoteAmount: "5" },
    askDepth: { baseAmount: "5", quoteAmount: "5.5" },
  };
}

function createFixture(): {
  database: ReturnType<typeof openDatabase>;
  addSnapshot: (receivedAtMs: number, book?: OrderBookSnapshot, integrity?: "valid" | "rejected") => number;
  addCandidate: (options?: {
    id?: string;
    side?: "buy" | "sell";
    decisionStatus?: "positive" | "insufficient_data" | "rejected";
    placementAtMs?: number;
    expiresAtMs?: number;
    snapshotId?: number;
    visibleQueue?: string;
    queueLower?: string;
    queueUpper?: string;
    cursor?: string | null;
    limitPrice?: string;
    requestedBase?: string;
  }) => string;
  addTrade: (options?: {
    id?: string;
    cursor?: string;
    occurredAtMs?: number;
    receivedAtMs?: number;
    baseAmount?: string;
    priceNumerator?: string;
    priceDenominator?: string;
    baseIsSeller?: 0 | 1;
    validationStatus?: "valid" | "rejected" | "quarantined" | "unverified";
  }) => void;
} {
  const database = openDatabase(":memory:");
  database.prepare(`
    INSERT INTO assets (asset_id, asset_type) VALUES ('native', 'native')
  `).run();
  database.prepare(`
    INSERT INTO assets (asset_id, asset_type, code, issuer)
    VALUES ('USD:ISSUER', 'credit', 'USD', 'ISSUER')
  `).run();
  database.prepare(`
    INSERT INTO trading_pairs (pair_id, base_asset_id, quote_asset_id)
    VALUES (?, 'native', 'USD:ISSUER')
  `).run(PAIR_ID);

  const addSnapshot = (
    receivedAtMs: number,
    book = makeBook(receivedAtMs),
    integrity: "valid" | "rejected" = "valid",
  ): number => {
    const result = database.prepare(`
      INSERT INTO market_snapshots (
        pair_id, received_at_ms, snapshot_json, content_hash, integrity_status,
        validation_reasons_json, received_sequence
      ) VALUES (?, ?, ?, ?, ?, '[]', ?)
    `).run(
      PAIR_ID,
      receivedAtMs,
      JSON.stringify(book),
      `hash-${receivedAtMs}-${book.bids[0]?.amount ?? "empty"}`,
      integrity,
      receivedAtMs,
    );
    return Number(result.lastInsertRowid);
  };

  const initialSnapshotId = addSnapshot(PLACEMENT_AT - 1_000);
  const addCandidate = (options: {
    id?: string;
    side?: "buy" | "sell";
    decisionStatus?: "positive" | "insufficient_data" | "rejected";
    placementAtMs?: number;
    expiresAtMs?: number;
    snapshotId?: number;
    visibleQueue?: string;
    queueLower?: string;
    queueUpper?: string;
    cursor?: string | null;
    limitPrice?: string;
    requestedBase?: string;
  } = {}): string => {
    const id = options.id ?? "candidate-1";
    const side = options.side ?? "buy";
    const placementAtMs = options.placementAtMs ?? PLACEMENT_AT;
    const expiresAtMs = options.expiresAtMs ?? placementAtMs + 20_000;
    const snapshotId = options.snapshotId ?? initialSnapshotId;
    const limitPrice = options.limitPrice ?? (side === "buy" ? "1" : "1.1");
    const visibleQueue = options.visibleQueue ?? "5";
    const queueLower = options.queueLower ?? visibleQueue;
    const queueUpper = options.queueUpper ?? visibleQueue;
    const decisionStatus = options.decisionStatus ?? "insufficient_data";
    const decisionId = `decision-${id}`;
    const orderId = `order-${id}`;
    database.prepare(`
      INSERT INTO strategy_decisions (
        decision_id, pair_id, snapshot_id, side, status, reasons_json,
        fee_estimate_json, created_at_ms, observed_at_ms
      ) VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?)
    `).run(
      decisionId,
      PAIR_ID,
      snapshotId,
      side,
      decisionStatus,
      JSON.stringify({ networkFeeQuote: "0.02", complete: true }),
      placementAtMs,
      placementAtMs,
    );
    database.prepare(`
      INSERT INTO hypothetical_orders (
        hypothetical_order_id, decision_id, pair_id, strategy_id, side,
        limit_price, requested_base, snapshot_id, start_cursor, observed_at_ms,
        expires_at_ms, displayed_queue_ahead_base, queue_lower_bound_base,
        queue_upper_bound_base, status, quality_reasons_json
      ) VALUES (?, ?, ?, 'passive_maker', ?, ?, '2', ?, ?, ?, ?, ?, ?, ?,
        'rejected', '[]')
    `).run(
      orderId,
      decisionId,
      PAIR_ID,
      side,
      limitPrice,
      snapshotId,
      options.cursor === undefined ? "100" : options.cursor,
      placementAtMs,
      expiresAtMs,
      visibleQueue,
      queueLower,
      queueUpper,
    );
    return orderId;
  };

  const addTrade = (options: {
    id?: string;
    cursor?: string;
    occurredAtMs?: number;
    receivedAtMs?: number;
    baseAmount?: string;
    priceNumerator?: string;
    priceDenominator?: string;
    baseIsSeller?: 0 | 1;
    validationStatus?: "valid" | "rejected" | "quarantined" | "unverified";
  } = {}): void => {
    const id = options.id ?? "trade-101";
    const cursor = options.cursor ?? "101";
    const occurredAtMs = options.occurredAtMs ?? PLACEMENT_AT + 3_000;
    const receivedAtMs = options.receivedAtMs ?? PLACEMENT_AT + 3_500;
    database.prepare(`
      INSERT OR IGNORE INTO market_trades (
        trade_id, pair_id, cursor, occurred_at_ms, base_amount,
        price_numerator, price_denominator, base_is_seller, trade_type,
        received_at_ms, received_sequence, validation_status, validation_reasons_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'orderbook', ?, ?, ?, '[]')
    `).run(
      id,
      PAIR_ID,
      cursor,
      occurredAtMs,
      options.baseAmount ?? "6",
      options.priceNumerator ?? "1",
      options.priceDenominator ?? "1",
      options.baseIsSeller ?? 1,
      receivedAtMs,
      Number(cursor.split("-").at(-1)),
      options.validationStatus ?? "valid",
    );
  };

  return { database, addSnapshot, addCandidate, addTrade };
}

function finishCoverage(addSnapshot: (receivedAtMs: number, book?: OrderBookSnapshot) => number): void {
  addSnapshot(PLACEMENT_AT + 21_000);
}

describe("HistoricalReplayEngine", () => {
  it("creates an independent research scenario for an insufficient-data decision without paper orders", () => {
    const fixture = createFixture();
    try {
      fixture.addCandidate({ decisionStatus: "insufficient_data" });
      finishCoverage(fixture.addSnapshot);

      const summary = new HistoricalReplayEngine(fixture.database).run();

      expect(summary.scenarioCount).toBe(1);
      expect(summary.scenarioStatuses.no_fill_evidence).toBe(1);
      expect(summary.executionMode).toBe("independent_counterfactual");
      expect(summary.portfolioSimulationImplemented).toBe(false);
      expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM paper_orders").get())
        .toEqual({ count: 0 });
      expect(fixture.database.prepare(`
        SELECT status FROM strategy_decisions
      `).get()).toEqual({ status: "insufficient_data" });
      expect(buildObservationReport({
        database: fixture.database,
        portfolioId: "default",
      }).historicalReplay).toMatchObject({
        executionMode: "independent_counterfactual",
        noFillEvidence: 1,
        portfolioSimulationImplemented: false,
      });
    } finally {
      fixture.database.close();
    }
  });

  it("models a partial buy fill only after exact-price volume exhausts the queue", () => {
    const fixture = createFixture();
    try {
      fixture.addCandidate();
      fixture.addTrade({ baseAmount: "6" });
      fixture.addSnapshot(
        PLACEMENT_AT + 21_000,
        makeBook(PLACEMENT_AT + 21_000, [], [{ price: "1.1", amount: "5" }]),
      );

      const summary = new HistoricalReplayEngine(fixture.database).run();
      expect(summary.scenarioStatuses.partial_fill).toBe(1);
      expect(fixture.database.prepare(`
        SELECT estimated_fill_lower_base AS lower, estimated_fill_upper_base AS upper
        FROM research_execution_scenarios
      `).get()).toEqual({ lower: "1", upper: "1" });
    } finally {
      fixture.database.close();
    }
  });

  it("requires the correct trade direction for a hypothetical sell", () => {
    const fixture = createFixture();
    try {
      fixture.addCandidate({ side: "sell" });
      fixture.addTrade({ baseIsSeller: 1, priceNumerator: "11", priceDenominator: "10" });
      fixture.addTrade({
        id: "trade-102",
        cursor: "102",
        baseIsSeller: 0,
        priceNumerator: "11",
        priceDenominator: "10",
      });
      finishCoverage(fixture.addSnapshot);

      const summary = new HistoricalReplayEngine(fixture.database).run();
      expect(summary.scenarioStatuses.partial_fill).toBe(1);
      expect(fixture.database.prepare(`
        SELECT COUNT(*) AS count FROM research_execution_events
        WHERE trade_id = 'trade-101'
      `).get()).toEqual({ count: 0 });
    } finally {
      fixture.database.close();
    }
  });

  it("does not claim a price-through trade as a confirmed fill", () => {
    const fixture = createFixture();
    try {
      fixture.addCandidate();
      fixture.addTrade({ priceNumerator: "9", priceDenominator: "10", baseAmount: "10" });
      finishCoverage(fixture.addSnapshot);

      const summary = new HistoricalReplayEngine(fixture.database).run();
      expect(summary.scenarioStatuses.uncertain).toBe(1);
      expect(summary.fillEvidence.uncertainFillEvents).toBe(1);
      expect(summary.fillEvidence.scenariosWithPossibleFill).toBe(1);
      expect(fixture.database.prepare(`
        SELECT fill_classification AS classification,
          modeled_fill_lower_base AS lower, modeled_fill_upper_base AS upper
        FROM research_execution_events
      `).get()).toEqual({ classification: "uncertain_fill", lower: "0", upper: "2" });
    } finally {
      fixture.database.close();
    }
  });

  it("marks queue cancellations as uncertain before using later trade evidence", () => {
    const fixture = createFixture();
    try {
      fixture.addCandidate();
      fixture.addSnapshot(PLACEMENT_AT + 2_000, makeBook(PLACEMENT_AT + 2_000, [
        { price: "1", amount: "2" },
      ]));
      fixture.addTrade({ occurredAtMs: PLACEMENT_AT + 5_000, receivedAtMs: PLACEMENT_AT + 6_000, baseAmount: "3" });
      finishCoverage(fixture.addSnapshot);

      const summary = new HistoricalReplayEngine(fixture.database).run();
      expect(summary.scenarioStatuses.uncertain).toBe(1);
      expect(fixture.database.prepare(`
        SELECT quality_reasons_json AS reasons FROM research_execution_scenarios
      `).get()).toMatchObject({
        reasons: expect.stringContaining("queue_change_between_snapshots_is_attribution_ambiguous"),
      });
    } finally {
      fixture.database.close();
    }
  });

  it("does not double-count a delayed trade already reflected in a snapshot", () => {
    const fixture = createFixture();
    try {
      fixture.addCandidate({ visibleQueue: "5", queueLower: "5", queueUpper: "5" });
      fixture.addSnapshot(
        PLACEMENT_AT + 2_000,
        makeBook(PLACEMENT_AT + 2_000, [{ price: "1", amount: "2" }]),
      );
      fixture.addTrade({
        occurredAtMs: PLACEMENT_AT + 1_500,
        receivedAtMs: PLACEMENT_AT + 4_000,
        baseAmount: "3",
      });
      finishCoverage(fixture.addSnapshot);

      new HistoricalReplayEngine(fixture.database).run();
      expect(fixture.database.prepare(`
        SELECT estimated_fill_lower_base AS lower FROM research_execution_scenarios
      `).get()).toEqual({ lower: "0" });
      expect(fixture.database.prepare(`
        SELECT estimated_fill_upper_base AS upper FROM research_execution_scenarios
      `).get()).toEqual({ upper: "0" });
    } finally {
      fixture.database.close();
    }
  });

  it("treats new same-price liquidity as queue uncertainty", () => {
    const fixture = createFixture();
    try {
      fixture.addCandidate();
      fixture.addSnapshot(PLACEMENT_AT + 2_000, makeBook(PLACEMENT_AT + 2_000, [
        { price: "1", amount: "7" },
      ]));
      fixture.addTrade({ occurredAtMs: PLACEMENT_AT + 5_000, receivedAtMs: PLACEMENT_AT + 6_000, baseAmount: "8" });
      finishCoverage(fixture.addSnapshot);

      const summary = new HistoricalReplayEngine(fixture.database).run();
      expect(summary.scenarioStatuses.uncertain).toBe(1);
    } finally {
      fixture.database.close();
    }
  });

  it("deduplicates trade events and makes identical reruns idempotent", () => {
    const fixture = createFixture();
    try {
      fixture.addCandidate();
      fixture.addTrade();
      fixture.addTrade();
      finishCoverage(fixture.addSnapshot);
      const engine = new HistoricalReplayEngine(fixture.database);

      const first = engine.run();
      const second = engine.run();

      expect(second.replayRunId).toBe(first.replayRunId);
      expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM research_execution_scenarios").get())
        .toEqual({ count: 1 });
      expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM research_execution_events").get())
        .toEqual({ count: 1 });
    } finally {
      fixture.database.close();
    }
  });

  it("marks long snapshot gaps incomplete", () => {
    const fixture = createFixture();
    try {
      fixture.addCandidate({ expiresAtMs: PLACEMENT_AT + 10 * 60_000 });
      fixture.addSnapshot(PLACEMENT_AT + 10 * 60_000 + 1_000);

      const summary = new HistoricalReplayEngine(fixture.database).run();
      expect(summary.scenarioStatuses.incomplete).toBe(1);
    } finally {
      fixture.database.close();
    }
  });

  it("fails closed when a recorded trade-stream gap overlaps the scenario", () => {
    const fixture = createFixture();
    try {
      fixture.addCandidate();
      finishCoverage(fixture.addSnapshot);
      fixture.database.prepare(`
        INSERT INTO market_data_gaps (
          gap_id, pair_id, source, detected_at_ms, status, reason
        ) VALUES ('gap-1', ?, 'horizon_sse', ?, 'unrecoverable', 'test gap')
      `).run(PAIR_ID, PLACEMENT_AT + 5_000);

      const summary = new HistoricalReplayEngine(fixture.database).run();
      expect(summary.scenarioStatuses.incomplete).toBe(1);
    } finally {
      fixture.database.close();
    }
  });

  it("marks ambiguous out-of-order trade event times uncertain", () => {
    const fixture = createFixture();
    try {
      fixture.addCandidate();
      fixture.addTrade({
        id: "trade-101",
        cursor: "101",
        occurredAtMs: PLACEMENT_AT + 8_000,
        receivedAtMs: PLACEMENT_AT + 9_000,
      });
      fixture.addTrade({
        id: "trade-102",
        cursor: "102",
        occurredAtMs: PLACEMENT_AT + 4_000,
        receivedAtMs: PLACEMENT_AT + 10_000,
      });
      finishCoverage(fixture.addSnapshot);

      const summary = new HistoricalReplayEngine(fixture.database).run();
      expect(summary.scenarioStatuses.uncertain).toBe(1);
    } finally {
      fixture.database.close();
    }
  });

  it("ignores trades whose event time predates placement", () => {
    const fixture = createFixture();
    try {
      fixture.addCandidate();
      fixture.addTrade({
        occurredAtMs: PLACEMENT_AT - 1,
        receivedAtMs: PLACEMENT_AT + 3_500,
      });
      finishCoverage(fixture.addSnapshot);

      const summary = new HistoricalReplayEngine(fixture.database).run();
      expect(summary.scenarioStatuses.uncertain).toBe(1);
      expect(fixture.database.prepare(`
        SELECT estimated_fill_upper_base AS upper FROM research_execution_scenarios
      `).get()).toEqual({ upper: "0" });
    } finally {
      fixture.database.close();
    }
  });

  it("does not call a ledger-close time well before placement ambiguous", () => {
    const fixture = createFixture();
    try {
      fixture.addCandidate();
      fixture.addTrade({
        occurredAtMs: PLACEMENT_AT - 3_000,
        receivedAtMs: PLACEMENT_AT + 3_500,
      });
      finishCoverage(fixture.addSnapshot);

      const summary = new HistoricalReplayEngine(fixture.database).run();
      expect(summary.scenarioStatuses.no_fill_evidence).toBe(1);
      expect(fixture.database.prepare(`
        SELECT quality_reasons_json AS reasons FROM research_execution_scenarios
      `).get()).toMatchObject({
        reasons: expect.not.stringContaining("trade_event_time_not_after_placement"),
      });
    } finally {
      fixture.database.close();
    }
  });

  it("does not attach pre-placement timestamp uncertainty to wrong-side or wrong-price trades", () => {
    for (const trade of [
      { baseIsSeller: 0 as const, priceNumerator: "1", priceDenominator: "1" },
      { baseIsSeller: 1 as const, priceNumerator: "2", priceDenominator: "1" },
    ]) {
      const fixture = createFixture();
      try {
        fixture.addCandidate();
        fixture.addTrade({
          ...trade,
          occurredAtMs: PLACEMENT_AT - 3_000,
          receivedAtMs: PLACEMENT_AT + 3_500,
        });
        finishCoverage(fixture.addSnapshot);

        const summary = new HistoricalReplayEngine(fixture.database).run();
        expect(summary.scenarioStatuses.no_fill_evidence).toBe(1);
        expect(fixture.database.prepare(`
          SELECT quality_reasons_json AS reasons FROM research_execution_scenarios
        `).get()).toMatchObject({
          reasons: expect.not.stringContaining("ledger_close_time_precision_makes_ordering_ambiguous"),
        });
      } finally {
        fixture.database.close();
      }
    }
  });

  it("classifies relevant same-ledger trades as uncertain and later trades as eligible", () => {
    const ambiguous = createFixture();
    try {
      ambiguous.addCandidate();
      ambiguous.addTrade({
        occurredAtMs: PLACEMENT_AT + 500,
        receivedAtMs: PLACEMENT_AT + 1_500,
      });
      finishCoverage(ambiguous.addSnapshot);

      const summary = new HistoricalReplayEngine(ambiguous.database).run();
      expect(summary.scenarioStatuses.uncertain).toBe(1);
      expect(ambiguous.database.prepare(`
        SELECT COUNT(*) AS count FROM research_execution_events
      `).get()).toEqual({ count: 0 });
    } finally {
      ambiguous.database.close();
    }

    const eligible = createFixture();
    try {
      eligible.addCandidate();
      eligible.addTrade({
        occurredAtMs: PLACEMENT_AT + 2_000,
        receivedAtMs: PLACEMENT_AT + 2_500,
        baseAmount: "6",
      });
      finishCoverage(eligible.addSnapshot);

      const summary = new HistoricalReplayEngine(eligible.database).run();
      expect(summary.scenarioStatuses.partial_fill).toBe(1);
    } finally {
      eligible.database.close();
    }
  });

  it("uses the ledger-close guard for scenarios whose starting cursor is now", () => {
    const fixture = createFixture();
    try {
      fixture.addCandidate({ cursor: "now" });
      fixture.addTrade({
        occurredAtMs: PLACEMENT_AT + 2_000,
        receivedAtMs: PLACEMENT_AT + 2_500,
        baseAmount: "6",
      });
      finishCoverage(fixture.addSnapshot);

      const summary = new HistoricalReplayEngine(fixture.database).run();
      expect(summary.scenarioStatuses.partial_fill).toBe(1);
    } finally {
      fixture.database.close();
    }
  });

  it("marks invalid event timestamps incomplete instead of using them as fill evidence", () => {
    const fixture = createFixture();
    try {
      fixture.addCandidate();
      fixture.addTrade({
        occurredAtMs: 0,
        receivedAtMs: PLACEMENT_AT + 3_500,
      });
      finishCoverage(fixture.addSnapshot);

      const summary = new HistoricalReplayEngine(fixture.database).run();
      expect(summary.scenarioStatuses.incomplete).toBe(1);
      expect(fixture.database.prepare(`
        SELECT estimated_fill_upper_base AS upper FROM research_execution_scenarios
      `).get()).toEqual({ upper: "0" });
    } finally {
      fixture.database.close();
    }
  });

  it("does not consider trades received after scenario expiry", () => {
    const fixture = createFixture();
    try {
      fixture.addCandidate();
      fixture.addTrade({
        occurredAtMs: PLACEMENT_AT + 25_000,
        receivedAtMs: PLACEMENT_AT + 26_000,
      });
      finishCoverage(fixture.addSnapshot);

      const summary = new HistoricalReplayEngine(fixture.database).run();
      expect(summary.scenarioStatuses.no_fill_evidence).toBe(1);
      expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM research_execution_events").get())
        .toEqual({ count: 0 });
    } finally {
      fixture.database.close();
    }
  });

  it("rejects trades with event timestamps beyond the scenario or receipt time", () => {
    const fixture = createFixture();
    try {
      fixture.addCandidate();
      fixture.addTrade({
        occurredAtMs: PLACEMENT_AT + 21_000,
        receivedAtMs: PLACEMENT_AT + 19_000,
      });
      finishCoverage(fixture.addSnapshot);

      const summary = new HistoricalReplayEngine(fixture.database).run();
      expect(summary.scenarioStatuses.incomplete).toBe(1);
      expect(summary.fillEvidence.scenariosWithPossibleFill).toBe(0);
    } finally {
      fixture.database.close();
    }
  });

  it("evaluates overlapping scenarios independently without consuming shared volume", () => {
    const fixture = createFixture();
    try {
      fixture.addCandidate({ id: "candidate-1" });
      fixture.addCandidate({ id: "candidate-2" });
      fixture.addTrade({ baseAmount: "6" });
      finishCoverage(fixture.addSnapshot);

      const summary = new HistoricalReplayEngine(fixture.database).run();
      expect(summary.scenarioCount).toBe(2);
      expect(summary.scenarioStatuses.partial_fill).toBe(2);
      expect(summary.independentExperimentsMustNotBeSummedAsPortfolioPnl).toBe(true);
      expect(fixture.database.prepare(`
        SELECT COUNT(DISTINCT scenario_id) AS count FROM research_execution_events
      `).get()).toEqual({ count: 2 });
    } finally {
      fixture.database.close();
    }
  });

  it("samples separate 5-second markout horizons using executable liquidation depth", () => {
    const fixture = createFixture();
    try {
      fixture.addCandidate();
      fixture.addTrade({ baseAmount: "6" });
      fixture.addSnapshot(
        PLACEMENT_AT + 9_000,
        makeBook(PLACEMENT_AT + 9_000, [{ price: "0.99", amount: "5" }]),
      );
      finishCoverage(fixture.addSnapshot);

      const summary = new HistoricalReplayEngine(fixture.database).run();
      expect(summary.markoutsByHorizon[0]).toMatchObject({
        horizonSeconds: 5,
        complete: 1,
      });
      expect(fixture.database.prepare(`
        SELECT horizon_seconds AS horizon, status, fill_price AS price,
          sampled_at_ms AS sampledAt, sampling_deviation_ms AS deviation,
          fill_reference_snapshot_id AS referenceSnapshotId,
          fill_reference_at_ms AS referenceAt,
          fill_reference_deviation_ms AS referenceDeviation,
          fill_reference_time_basis AS referenceTimeBasis
        FROM research_markout_observations WHERE horizon_seconds = 5
      `).get()).toMatchObject({
        horizon: 5,
        status: "complete",
        price: "1",
        sampledAt: PLACEMENT_AT + 9_000,
        deviation: 1_000,
        referenceSnapshotId: expect.any(Number),
        referenceAt: PLACEMENT_AT - 1_000,
        referenceDeviation: 4_000,
        referenceTimeBasis: "snapshot_receive_time_vs_ledger_close_time",
      });
      expect(summary.markoutsByHorizon).toHaveLength(5);
      expect(buildObservationReport({
        database: fixture.database,
        portfolioId: "default",
      }).historicalReplay?.markoutDistributionsByPairStrategyHorizon).toContainEqual(
        expect.objectContaining({
          pairId: PAIR_ID,
          strategyId: "passive_maker",
          horizonSeconds: 5,
          sampleSize: 1,
          meanSamplingDeviationMs: 1_000,
          maxAbsoluteSamplingDeviationMs: 1_000,
          grossMeanQuote: "-0.01",
          netMeanQuote: "-0.02",
        }),
      );
    } finally {
      fixture.database.close();
    }
  });

  it("anchors markout spread capture and movement to the fill-time reference book", () => {
    const fixture = createFixture();
    try {
      fixture.addCandidate();
      fixture.addSnapshot(
        PLACEMENT_AT + 2_000,
        makeBook(
          PLACEMENT_AT + 2_000,
          [{ price: "1", amount: "5" }],
          [{ price: "1.3", amount: "5" }],
        ),
      );
      fixture.addTrade({ baseAmount: "6" });
      fixture.addSnapshot(
        PLACEMENT_AT + 9_000,
        makeBook(
          PLACEMENT_AT + 9_000,
          [{ price: "0.99", amount: "5" }],
          [{ price: "1.3", amount: "5" }],
        ),
      );
      finishCoverage(fixture.addSnapshot);

      new HistoricalReplayEngine(fixture.database).run();
      expect(fixture.database.prepare(`
        SELECT spread_capture_quote AS spread,
          post_fill_price_movement_quote AS movement,
          fill_reference_at_ms AS referenceAt,
          fill_reference_deviation_ms AS referenceDeviation
        FROM research_markout_observations WHERE horizon_seconds = 5
      `).get()).toEqual({
        spread: "0.15",
        movement: "-0.005",
        referenceAt: PLACEMENT_AT + 2_000,
        referenceDeviation: 1_000,
      });
    } finally {
      fixture.database.close();
    }
  });

  it("does not create markouts for uncertain price-through evidence", () => {
    const fixture = createFixture();
    try {
      fixture.addCandidate();
      fixture.addTrade({
        priceNumerator: "9",
        priceDenominator: "10",
        baseAmount: "100",
      });
      finishCoverage(fixture.addSnapshot);

      new HistoricalReplayEngine(fixture.database).run();
      expect(fixture.database.prepare(`
        SELECT COUNT(*) AS count FROM research_markout_observations
      `).get()).toEqual({ count: 0 });
    } finally {
      fixture.database.close();
    }
  });

  it("does not create markouts from a lower-bound fill in an uncertain scenario", () => {
    const fixture = createFixture();
    try {
      fixture.addCandidate();
      fixture.addSnapshot(
        PLACEMENT_AT + 2_000,
        makeBook(PLACEMENT_AT + 2_000, [{ price: "1", amount: "2" }]),
      );
      fixture.addTrade({
        occurredAtMs: PLACEMENT_AT + 5_000,
        receivedAtMs: PLACEMENT_AT + 6_000,
        baseAmount: "6",
      });
      finishCoverage(fixture.addSnapshot);

      const summary = new HistoricalReplayEngine(fixture.database).run();
      expect(summary.scenarioStatuses.uncertain).toBe(1);
      expect(summary.fillEvidence.scenariosWithLowerBoundFill).toBe(1);
      expect(fixture.database.prepare(`
        SELECT COUNT(*) AS count FROM research_markout_observations
      `).get()).toEqual({ count: 0 });
    } finally {
      fixture.database.close();
    }
  });

  it("uses sell-side direction and estimated fees in net markout", () => {
    const fixture = createFixture();
    try {
      fixture.addCandidate({ side: "sell" });
      fixture.addTrade({
        baseIsSeller: 0,
        priceNumerator: "11",
        priceDenominator: "10",
        baseAmount: "6",
      });
      fixture.addSnapshot(
        PLACEMENT_AT + 9_000,
        makeBook(
          PLACEMENT_AT + 9_000,
          [{ price: "1.1", amount: "5" }],
          [{ price: "1.2", amount: "5" }],
        ),
      );
      finishCoverage(fixture.addSnapshot);

      new HistoricalReplayEngine(fixture.database).run();
      expect(fixture.database.prepare(`
        SELECT spread_capture_quote AS spread, post_fill_price_movement_quote AS movement,
          liquidation_impact_quote AS liquidation, estimated_fees_quote AS fees,
          net_markout_quote AS net
        FROM research_markout_observations WHERE horizon_seconds = 5
      `).get()).toEqual({
        spread: "0.05",
        movement: "-0.1",
        liquidation: "-0.05",
        fees: "0.01",
        net: "-0.11",
      });
    } finally {
      fixture.database.close();
    }
  });

  it("rejects delayed markout samples outside the configured tolerance", () => {
    const fixture = createFixture();
    try {
      fixture.addCandidate();
      fixture.addTrade({ baseAmount: "6" });
      fixture.addSnapshot(
        PLACEMENT_AT + 16_000,
        makeBook(PLACEMENT_AT + 16_000, [{ price: "0.99", amount: "5" }]),
      );
      finishCoverage(fixture.addSnapshot);

      const summary = new HistoricalReplayEngine(fixture.database, {
        maxMarkoutSampleDelayMs: 5_000,
      }).run();
      expect(summary.markoutsByHorizon[0]).toMatchObject({
        horizonSeconds: 5,
        invalid: 1,
      });
      expect(fixture.database.prepare(`
        SELECT sampled_at_ms AS sampledAt, sampling_deviation_ms AS deviation,
          status, quality_reasons_json AS reasons
        FROM research_markout_observations WHERE horizon_seconds = 5
      `).get()).toEqual({
        sampledAt: PLACEMENT_AT + 16_000,
        deviation: 8_000,
        status: "invalid",
        reasons: '["markout_sample_exceeds_sampling_tolerance"]',
      });
      expect(buildObservationReport({
        database: fixture.database,
        portfolioId: "default",
      }).historicalReplay?.markoutDistributionsByPairStrategyHorizon).toContainEqual(
        expect.objectContaining({
          horizonSeconds: 5,
          sampleSize: 0,
          meanSamplingDeviationMs: 8_000,
          maxAbsoluteSamplingDeviationMs: 8_000,
        }),
      );
    } finally {
      fixture.database.close();
    }
  });
});
