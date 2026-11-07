import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { TradingPairConfig } from "../src/config/schema.js";
import { normalizeOrderBook } from "../src/order-book/normalize.js";
import type { OrderBookSnapshot } from "../src/order-book/types.js";
import { PaperTradingEngine } from "../src/paper-trading/paper-trading-engine.js";
import { getPaperBalance, initializePaperPortfolio, reconcilePaperBalances } from "../src/paper-trading/portfolio.js";
import { buildPaperTradingReport } from "../src/reporting/paper-report.js";
import { openDatabase } from "../src/storage/database.js";
import {
  persistAssetValidation,
  recordMarketSnapshot,
  recordStrategyDecision,
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
const quoteAssetId = "USDC:GA24LJXFG73JGARIBG2GP6V5TNUUOS6BD23KOFCW3INLDY5KPKS7GACZ";
const portfolioId = "test-portfolio";
let clientOrderSequence = 0;
const config = {
  maxOrderBookAgeMs: 10_000,
  maximumMakerOrderBase: "10",
  maximumInventoryBase: "10",
  makerReplacementsPerOrder: 0,
  feeConversionProbeXlm: "1",
  feeConversionMaxDeviationBps: 200,
  assetValidationMaxAgeMs: 100_000,
  paperEmergencyStop: false,
  paperMaxDailyLossByQuote: { [quoteAssetId]: "25" },
};

function createBook(nowMs: number, askAmount = "5"): OrderBookSnapshot {
  return normalizeOrderBook({
    bids: [{ price_r: { n: 99, d: 100 }, amount: "5" }],
    asks: [{ price_r: { n: 101, d: 100 }, amount: askAmount }],
  }, pair, nowMs);
}

function setup(book: OrderBookSnapshot, databasePath = ":memory:") {
  const database = openDatabase(databasePath);
  const pairId = registerTradingPair(database, pair);
  for (const asset of [pair.base, pair.quote]) {
    persistAssetValidation({
      database,
      asset,
      status: "verified",
      homeDomain: asset.type === "credit" ? "example.org" : null,
      validatedAtMs: book.receivedAtMs,
      error: null,
    });
  }
  initializePaperPortfolio({
    database,
    portfolioId,
    initialBalances: { native: "1", [quoteAssetId]: "100" },
    nowMs: book.receivedAtMs,
  });
  database.prepare(`
    INSERT INTO paper_lots (
      lot_id, portfolio_id, pair_id, base_asset_id, quote_asset_id,
      original_base, remaining_base, unit_cost_quote, created_at_ms
    ) VALUES ('opening-xlm-lot', ?, ?, 'native', ?, '1', '1', '0.98', ?)
  `).run(portfolioId, pairId, quoteAssetId, book.receivedAtMs);
  const snapshotId = recordMarketSnapshot(database, book, []);
  const decisionId = recordStrategyDecision({
    database,
    pairId,
    snapshotId,
    side: "buy",
    status: "positive",
    reasons: [],
    evidence: undefined,
    feeEstimate: {},
    createdAtMs: book.receivedAtMs,
  });
  const engine = new PaperTradingEngine(database, config);
  const fees = {
    operationFeeStroops: "100",
    quoteAssetId,
    quotePerXlm: "1",
    conversionPath: ["XLM", quoteAssetId],
    conversionSnapshotId: snapshotId,
    referenceBook: book,
  };
  return { database, snapshotId, decisionId, engine, fees, pairId };
}

function submit(
  fixture: ReturnType<typeof setup>,
  book: OrderBookSnapshot,
  options: {
    orderType?: "limit" | "marketable_limit";
    limitPrice?: string;
    baseAmount?: string;
    nowMs?: number;
  } = {},
) {
  return fixture.engine.submitOrder({
    portfolioId,
    pair,
    decisionId: fixture.decisionId,
    clientOrderKey: `client-${++clientOrderSequence}`,
    orderType: options.orderType ?? "limit",
    side: "buy",
    limitPrice: options.limitPrice ?? "0.99",
    baseAmount: options.baseAmount ?? "2",
    book,
    snapshotId: fixture.snapshotId,
    fees: fixture.fees,
    nowMs: options.nowMs ?? book.receivedAtMs,
  });
}

describe("PaperTradingEngine", () => {
  it("uses trade-through evidence for partial fills and deduplicates trades", () => {
    const nowMs = 1_000;
    const book = createBook(nowMs);
    const fixture = setup(book);
    try {
      const order = submit(fixture, book);
      expect(order.reason).toBeNull();
      expect(order.status).toBe("open");
      fixture.database.prepare(`
        INSERT INTO stream_cursors (pair_id, trade_cursor, updated_at_ms)
        VALUES (?, 'now', ?)
      `).run(book.pairId, nowMs);

      const trade = {
        tradeId: "trade-1",
        cursor: "1",
        pairId: book.pairId,
        baseAmount: "5.5",
        priceNumerator: "98",
        priceDenominator: "100",
        baseIsSeller: true,
        tradeType: "orderbook",
        occurredAtMs: nowMs + 1,
      };
      expect(fixture.engine.processTrade({
        trade,
        book,
        snapshotId: fixture.snapshotId,
        nowMs: nowMs + 1,
      })).toEqual({ duplicate: false, fillCount: 1, pausedOrders: 0 });
      expect(fixture.engine.processTrade({
        trade,
        book,
        snapshotId: fixture.snapshotId,
        nowMs: nowMs + 2,
      })).toEqual({ duplicate: true, fillCount: 0, pausedOrders: 0 });
      expect(fixture.database.prepare(`
        SELECT trade_cursor FROM stream_cursors WHERE pair_id = ?
      `).get(book.pairId)).toEqual({ trade_cursor: "1" });

      expect(fixture.database.prepare(`
        SELECT base_amount, price, quote_amount, source_kind
        FROM paper_fills
      `).all()).toEqual([{
        base_amount: "0.5",
        price: "0.98",
        quote_amount: "0.49",
        source_kind: "trade",
      }]);
      expect(getPaperBalance(fixture.database, portfolioId, "native")).toEqual({
        assetId: "native",
        available: "1.49998",
        reserved: "0.00001",
      });
      expect(getPaperBalance(fixture.database, portfolioId, quoteAssetId)).toEqual({
        assetId: quoteAssetId,
        available: "98.025",
        reserved: "1.485",
      });
      const report = buildPaperTradingReport({
        database: fixture.database,
        portfolioId,
        books: new Map([[book.pairId, book]]),
        signals: new Map(),
        maxOrderBookAgeMs: config.maxOrderBookAgeMs,
        nowMs: nowMs + 2,
      });
      expect(report.openOrders).toHaveLength(1);
      expect(report.recentSignalSummary).toEqual({
        sampleSize: 1,
        byStatus: { positive: 1, rejected: 0, insufficient_data: 0 },
        rejectionReasons: [],
      });
      expect(report.pnlByQuoteAsset).toEqual([{
        pairId: book.pairId,
        quoteAssetId,
        realizedGrossPnlQuote: "0",
        unrealizedGrossPnlQuote: "0.015",
        simulatedFeesXlm: "0.00001",
        estimatedFeesQuote: "0.00001",
        netPnlQuote: "0.01499",
        complete: true,
      }]);
    } finally {
      fixture.database.close();
    }
  });

  it("does not fill on price touch and fills marketable limits only to displayed depth", () => {
    const nowMs = 2_000;
    const book = createBook(nowMs, "0.5");
    const fixture = setup(book);
    try {
      const passive = submit(fixture, book);
      const touchTrade = {
        tradeId: "touch-trade",
        cursor: "2",
        pairId: book.pairId,
        baseAmount: "10",
        priceNumerator: "1",
        priceDenominator: "1",
        baseIsSeller: true,
        tradeType: "orderbook",
        occurredAtMs: nowMs + 1,
      };
      fixture.engine.processTrade({
        trade: touchTrade,
        book,
        snapshotId: fixture.snapshotId,
        nowMs: nowMs + 1,
      });
      expect(fixture.database.prepare(
        "SELECT COUNT(*) AS count FROM paper_fills WHERE order_id = ?",
      ).get(passive.orderId)).toEqual({ count: 0 });

      const marketable = submit(fixture, book, {
        orderType: "marketable_limit",
        limitPrice: "1.01",
        nowMs: nowMs + 2,
      });
      expect(marketable.status).toBe("partially_filled");
      expect(fixture.database.prepare(`
        SELECT base_amount, price, source_kind FROM paper_fills WHERE order_id = ?
      `).get(marketable.orderId)).toEqual({
        base_amount: "0.5",
        price: "1.01",
        source_kind: "book_depth",
      });
      expect(getPaperBalance(fixture.database, portfolioId, quoteAssetId).reserved).toBe("3.495");

      const competing = submit(fixture, book, {
        orderType: "marketable_limit",
        limitPrice: "1.01",
        baseAmount: "0.5",
        nowMs: nowMs + 3,
      });
      expect(competing.status).toBe("open");
      expect(fixture.database.prepare(
        "SELECT COUNT(*) AS count FROM paper_fills WHERE order_id = ?",
      ).get(competing.orderId)).toEqual({ count: 0 });
    } finally {
      fixture.database.close();
    }
  });

  it("allocates each trade through existing price-time queue priority", () => {
    const nowMs = 2_500;
    const book = createBook(nowMs);
    const fixture = setup(book);
    try {
      const first = submit(fixture, book, { baseAmount: "2" });
      const second = submit(fixture, book, { baseAmount: "1" });
      expect(fixture.database.prepare(`
        SELECT queue_ahead_base FROM paper_orders WHERE order_id = ?
      `).get(second.orderId)).toEqual({ queue_ahead_base: "7" });

      const firstTrade = {
        tradeId: "priority-trade-1",
        cursor: "3",
        pairId: book.pairId,
        baseAmount: "6",
        priceNumerator: "98",
        priceDenominator: "100",
        baseIsSeller: true,
        tradeType: "orderbook",
        occurredAtMs: nowMs + 1,
      };
      fixture.engine.processTrade({
        trade: firstTrade,
        book,
        snapshotId: fixture.snapshotId,
        nowMs: nowMs + 1,
      });
      expect(fixture.database.prepare(`
        SELECT order_id, filled_base, queue_ahead_base
        FROM paper_orders WHERE order_id IN (?, ?) ORDER BY created_at_ms, rowid
      `).all(first.orderId, second.orderId)).toEqual([
        { order_id: first.orderId, filled_base: "1", queue_ahead_base: "0" },
        { order_id: second.orderId, filled_base: "0", queue_ahead_base: "1" },
      ]);

      fixture.engine.processTrade({
        trade: {
          ...firstTrade,
          tradeId: "priority-trade-2",
          cursor: "4",
          baseAmount: "2",
          occurredAtMs: nowMs + 2,
        },
        book,
        snapshotId: fixture.snapshotId,
        nowMs: nowMs + 2,
      });
      expect(fixture.database.prepare(`
        SELECT order_id, status, filled_base
        FROM paper_orders WHERE order_id IN (?, ?) ORDER BY created_at_ms, rowid
      `).all(first.orderId, second.orderId)).toEqual([
        { order_id: first.orderId, status: "filled", filled_base: "2" },
        { order_id: second.orderId, status: "filled", filled_base: "1" },
      ]);
    } finally {
      fixture.database.close();
    }
  });

  it("calculates realized FIFO P&L and simulated costs in quote units", () => {
    const nowMs = 2_750;
    const book = createBook(nowMs);
    const fixture = setup(book);
    try {
      const buy = submit(fixture, book, { baseAmount: "0.5" });
      fixture.engine.processTrade({
        trade: {
          tradeId: "round-trip-buy",
          cursor: "5",
          pairId: book.pairId,
          baseAmount: "5.5",
          priceNumerator: "98",
          priceDenominator: "100",
          baseIsSeller: true,
          tradeType: "orderbook",
          occurredAtMs: nowMs + 1,
        },
        book,
        snapshotId: fixture.snapshotId,
        nowMs: nowMs + 1,
      });
      expect(buy.status).toBe("open");

      const sellDecisionId = recordStrategyDecision({
        database: fixture.database,
        pairId: fixture.pairId,
        snapshotId: fixture.snapshotId,
        side: "sell",
        status: "positive",
        reasons: [],
        evidence: undefined,
        feeEstimate: {},
        createdAtMs: nowMs + 2,
      });
      const sell = fixture.engine.submitOrder({
        portfolioId,
        pair,
        decisionId: sellDecisionId,
        clientOrderKey: `client-${++clientOrderSequence}`,
        orderType: "limit",
        side: "sell",
        limitPrice: "1.01",
        baseAmount: "0.5",
        book,
        snapshotId: fixture.snapshotId,
        fees: fixture.fees,
        nowMs: nowMs + 2,
      });
      expect(sell.status).toBe("open");
      fixture.engine.processTrade({
        trade: {
          tradeId: "round-trip-sell",
          cursor: "6",
          pairId: book.pairId,
          baseAmount: "5.5",
          priceNumerator: "102",
          priceDenominator: "100",
          baseIsSeller: false,
          tradeType: "orderbook",
          occurredAtMs: nowMs + 3,
        },
        book,
        snapshotId: fixture.snapshotId,
        nowMs: nowMs + 3,
      });

      const report = buildPaperTradingReport({
        database: fixture.database,
        portfolioId,
        books: new Map([[book.pairId, book]]),
        signals: new Map(),
        maxOrderBookAgeMs: config.maxOrderBookAgeMs,
        nowMs: nowMs + 4,
      });
      expect(report.pnlByQuoteAsset).toEqual([{
        pairId: book.pairId,
        quoteAssetId,
        realizedGrossPnlQuote: "0.02",
        unrealizedGrossPnlQuote: "0.01",
        simulatedFeesXlm: "0.00002",
        estimatedFeesQuote: "0.00002",
        netPnlQuote: "0.02998",
        complete: true,
      }]);
      expect(fixture.database.prepare(`
        SELECT gross_pnl_quote AS grossPnlQuote FROM paper_realized_pnl
      `).get()).toEqual({ grossPnlQuote: "0.02" });
    } finally {
      fixture.database.close();
    }
  });

  it("charges simulated cancellation fees, releases reservations, and reconciles balances", () => {
    const nowMs = 3_000;
    const book = createBook(nowMs);
    const fixture = setup(book);
    try {
      const order = submit(fixture, book);
      expect(fixture.engine.cancelOrder(order.orderId, fixture.snapshotId, nowMs + 1).status)
        .toBe("cancelled");
      expect(getPaperBalance(fixture.database, portfolioId, "native")).toEqual({
        assetId: "native",
        available: "0.99998",
        reserved: "0",
      });
      expect(getPaperBalance(fixture.database, portfolioId, quoteAssetId)).toEqual({
        assetId: quoteAssetId,
        available: "100",
        reserved: "0",
      });
      expect(fixture.database.prepare(`
        SELECT event_type, estimated_fee_xlm, nature, actual_fee_xlm
        FROM paper_fee_entries ORDER BY created_at_ms, rowid
      `).all()).toEqual([
        {
          event_type: "placement",
          estimated_fee_xlm: "0.00001",
          nature: "simulated_estimate",
          actual_fee_xlm: null,
        },
        {
          event_type: "cancellation",
          estimated_fee_xlm: "0.00001",
          nature: "simulated_estimate",
          actual_fee_xlm: null,
        },
      ]);

      fixture.database.prepare(`
        UPDATE paper_balances SET available = '0', reserved = '0'
        WHERE portfolio_id = ? AND asset_id = ?
      `).run(portfolioId, quoteAssetId);
      reconcilePaperBalances(fixture.database, portfolioId);
      expect(getPaperBalance(fixture.database, portfolioId, quoteAssetId)).toEqual({
        assetId: quoteAssetId,
        available: "100",
        reserved: "0",
      });
    } finally {
      fixture.database.close();
    }
  });

  it("reopens the persisted portfolio and recovers partial orders, cursors, and balances", () => {
    const nowMs = 3_500;
    const tempDirectory = mkdtempSync(join(tmpdir(), "stellar-paper-restart-"));
    const databasePath = join(tempDirectory, "paper.sqlite");
    const book = createBook(nowMs);
    let database: ReturnType<typeof openDatabase> | undefined;
    try {
      const fixture = setup(book, databasePath);
      database = fixture.database;
      const order = submit(fixture, book);
      fixture.engine.processTrade({
        trade: {
          tradeId: "restart-trade",
          cursor: "77",
          pairId: book.pairId,
          baseAmount: "5.5",
          priceNumerator: "98",
          priceDenominator: "100",
          baseIsSeller: true,
          tradeType: "orderbook",
          occurredAtMs: nowMs + 1,
        },
        book,
        snapshotId: fixture.snapshotId,
        nowMs: nowMs + 1,
      });
      database.close();
      database = openDatabase(databasePath);

      expect(database.prepare(`
        SELECT status, filled_base, remaining_base
        FROM paper_orders WHERE order_id = ?
      `).get(order.orderId)).toEqual({
        status: "partially_filled",
        filled_base: "0.5",
        remaining_base: "1.5",
      });
      expect(database.prepare(`
        SELECT trade_cursor FROM stream_cursors WHERE pair_id = ?
      `).get(book.pairId)).toEqual({ trade_cursor: "77" });
      reconcilePaperBalances(database, portfolioId);
      expect(getPaperBalance(database, portfolioId, quoteAssetId)).toEqual({
        assetId: quoteAssetId,
        available: "98.025",
        reserved: "1.485",
      });
    } finally {
      database?.close();
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  it("rolls back order placement and reservations if a fill transaction fails", () => {
    const nowMs = 4_000;
    const book = createBook(nowMs, "5");
    const fixture = setup(book);
    try {
      fixture.database.exec(`
        CREATE TRIGGER reject_test_fills BEFORE INSERT ON paper_fills
        BEGIN SELECT RAISE(ABORT, 'injected fill failure'); END;
      `);
      expect(() => submit(fixture, book, {
        orderType: "marketable_limit",
        limitPrice: "1.01",
      })).toThrow("injected fill failure");
      expect(fixture.database.prepare(
        "SELECT COUNT(*) AS count FROM paper_orders",
      ).get()).toEqual({ count: 0 });
      expect(getPaperBalance(fixture.database, portfolioId, quoteAssetId)).toEqual({
        assetId: quoteAssetId,
        available: "100",
        reserved: "0",
      });
    } finally {
      fixture.database.close();
    }
  });

  it("enforces the quote-denominated daily loss limit using simulated fees", () => {
    const nowMs = 5_000;
    const book = createBook(nowMs);
    const fixture = setup(book);
    try {
      fixture.database.prepare(`
        UPDATE paper_lots SET unit_cost_quote = '0.99'
        WHERE lot_id = 'opening-xlm-lot'
      `).run();
      const constrained = {
        ...fixture,
        engine: new PaperTradingEngine(fixture.database, {
          ...config,
          paperMaxDailyLossByQuote: { [quoteAssetId]: "0.000025" },
        }),
      };
      expect(submit(constrained, book).status).toBe("open");
      const rejected = submit(constrained, book, { nowMs: nowMs + 1 });
      expect(rejected.status).toBe("rejected");
      expect(rejected.reason).toBe("maximum_daily_simulated_loss_reached");
    } finally {
      fixture.database.close();
    }
  });

  it("counts outstanding buy exposure against the base inventory cap", () => {
    const nowMs = 5_500;
    const book = createBook(nowMs);
    const fixture = setup(book);
    try {
      const constrained = {
        ...fixture,
        engine: new PaperTradingEngine(fixture.database, {
          ...config,
          maximumInventoryBase: "2",
        }),
      };
      expect(submit(constrained, book, { baseAmount: "1" }).status).toBe("open");
      const next = submit(constrained, book, {
        baseAmount: "0.1",
        nowMs: nowMs + 1,
      });
      expect(next.status).toBe("rejected");
      expect(next.reason).toBe("maximum_inventory_exceeded");
    } finally {
      fixture.database.close();
    }
  });

  it("rejects all paper orders while the emergency stop is active", () => {
    const nowMs = 6_000;
    const book = createBook(nowMs);
    const fixture = setup(book);
    try {
      const stopped = {
        ...fixture,
        engine: new PaperTradingEngine(fixture.database, {
          ...config,
          paperEmergencyStop: true,
        }),
      };
      const order = submit(stopped, book);
      expect(order.status).toBe("rejected");
      expect(order.reason).toBe("emergency_stop_active");
      expect(getPaperBalance(fixture.database, portfolioId, quoteAssetId)).toEqual({
        assetId: quoteAssetId,
        available: "100",
        reserved: "0",
      });
    } finally {
      fixture.database.close();
    }
  });

  it("rejects stale market snapshots before reserving virtual balances", () => {
    const nowMs = 7_000;
    const book = createBook(nowMs);
    const fixture = setup(book);
    try {
      const order = submit(fixture, book, {
        nowMs: nowMs + config.maxOrderBookAgeMs + 1,
      });
      expect(order.status).toBe("rejected");
      expect(order.reason).toBe("order_book_stale");
      expect(getPaperBalance(fixture.database, portfolioId, quoteAssetId)).toEqual({
        assetId: quoteAssetId,
        available: "100",
        reserved: "0",
      });
    } finally {
      fixture.database.close();
    }
  });
});
