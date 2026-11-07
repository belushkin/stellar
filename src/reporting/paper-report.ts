import type Database from "better-sqlite3";

import { Big } from "../common/decimal.js";
import type { PassiveMakerSignal } from "../strategies/passive-maker.js";
import { estimateExecutableVolume } from "../order-book/executable-volume.js";
import type { OrderBookSnapshot } from "../order-book/types.js";
import { validateOrderBookIntegrity } from "../market-data/market-integrity.js";

interface PairAssets {
  pair_id: string;
  base_asset_id: string;
  quote_asset_id: string;
}

export interface PaperPnlReport {
  pairId: string;
  quoteAssetId: string;
  realizedGrossPnlQuote: string | null;
  unrealizedGrossPnlQuote: string | null;
  simulatedFeesXlm: string;
  estimatedFeesQuote: string | null;
  netPnlQuote: string | null;
  complete: boolean;
}

export interface PaperTradingReport {
  generatedAtMs: number;
  portfolioId: string;
  recentSignalSummary: {
    sampleSize: number;
    byStatus: Record<"positive" | "rejected" | "insufficient_data", number>;
    rejectionReasons: Array<{ reason: string; count: number }>;
  };
  markets: Array<{
    pairId: string;
    bestBid: string | null;
    bestAsk: string | null;
    spreadAbsolute: string | null;
    spreadPercent: string | null;
    bidDepth: OrderBookSnapshot["bidDepth"];
    askDepth: OrderBookSnapshot["askDepth"];
    signals: PassiveMakerSignal[];
  }>;
  balances: Array<{
    assetId: string;
    available: string;
    reserved: string;
  }>;
  openOrders: Array<{
    orderId: string;
    pairId: string;
    side: "buy" | "sell";
    limitPrice: string;
    requestedBase: string;
    filledBase: string;
    remainingBase: string;
    status: string;
  }>;
  recentFills: Array<{
    fillId: string;
    orderId: string;
    pairId: string;
    side: "buy" | "sell";
    baseAmount: string;
    price: string;
    quoteAmount: string;
    sourceKind: "trade" | "book_depth";
    createdAtMs: number;
  }>;
  pnlByQuoteAsset: PaperPnlReport[];
}

export function buildPaperTradingReport(input: {
  database: Database.Database;
  portfolioId: string;
  books: ReadonlyMap<string, OrderBookSnapshot>;
  signals: ReadonlyMap<string, readonly PassiveMakerSignal[]>;
  maxOrderBookAgeMs: number;
  nowMs?: number;
}): PaperTradingReport {
  const nowMs = input.nowMs ?? Date.now();
  const markets = [...input.books].map(([pairId, book]) => ({
    pairId,
    bestBid: book.bestBid,
    bestAsk: book.bestAsk,
    spreadAbsolute: book.spreadAbsolute,
    spreadPercent: book.spreadPercent,
    bidDepth: book.bidDepth,
    askDepth: book.askDepth,
    signals: [...(input.signals.get(pairId) ?? [])],
  }));
  const balances = input.database.prepare(`
    SELECT asset_id AS assetId, available, reserved
    FROM paper_balances
    WHERE portfolio_id = ?
    ORDER BY asset_id
  `).all(input.portfolioId) as PaperTradingReport["balances"];
  const openOrders = input.database.prepare(`
    SELECT order_id AS orderId, pair_id AS pairId, side, limit_price AS limitPrice,
      requested_base AS requestedBase, filled_base AS filledBase,
      remaining_base AS remainingBase, status
    FROM paper_orders
    WHERE portfolio_id = ? AND status IN ('open', 'partially_filled', 'paused')
    ORDER BY created_at_ms, order_id
  `).all(input.portfolioId) as PaperTradingReport["openOrders"];
  const recentFills = input.database.prepare(`
    SELECT f.fill_id AS fillId, f.order_id AS orderId, o.pair_id AS pairId,
      o.side, f.base_amount AS baseAmount, f.price, f.quote_amount AS quoteAmount,
      f.source_kind AS sourceKind, f.created_at_ms AS createdAtMs
    FROM paper_fills f
    JOIN paper_orders o ON o.order_id = f.order_id
    WHERE o.portfolio_id = ?
    ORDER BY f.created_at_ms DESC, f.fill_id DESC
    LIMIT 50
  `).all(input.portfolioId) as PaperTradingReport["recentFills"];
  const recentDecisions = input.database.prepare(`
    SELECT status, reasons_json AS reasonsJson
    FROM strategy_decisions
    ORDER BY created_at_ms DESC, decision_id DESC
    LIMIT 500
  `).all() as { status: "positive" | "rejected" | "insufficient_data"; reasonsJson: string }[];
  const statusCounts: PaperTradingReport["recentSignalSummary"]["byStatus"] = {
    positive: 0,
    rejected: 0,
    insufficient_data: 0,
  };
  const reasonCounts = new Map<string, number>();
  for (const decision of recentDecisions) {
    statusCounts[decision.status] += 1;
    if (decision.status === "positive") {
      continue;
    }
    const reasons: unknown = JSON.parse(decision.reasonsJson);
    if (!Array.isArray(reasons) || reasons.some((reason) => typeof reason !== "string")) {
      throw new Error("Persisted strategy decision reasons are malformed");
    }
    for (const reason of reasons) {
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    }
  }
  const pairs = input.database.prepare(`
    SELECT pair_id, base_asset_id, quote_asset_id
    FROM trading_pairs
    WHERE enabled = 1
  `).all() as PairAssets[];
  const pnlByQuoteAsset = pairs.map((pair) => buildPairPnl({
    database: input.database,
    portfolioId: input.portfolioId,
    pair,
    book: input.books.get(pair.pair_id),
    maxOrderBookAgeMs: input.maxOrderBookAgeMs,
    nowMs,
  }));

  return {
    generatedAtMs: nowMs,
    portfolioId: input.portfolioId,
    recentSignalSummary: {
      sampleSize: recentDecisions.length,
      byStatus: statusCounts,
      rejectionReasons: [...reasonCounts]
        .map(([reason, count]) => ({ reason, count }))
        .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason)),
    },
    markets,
    balances,
    openOrders,
    recentFills,
    pnlByQuoteAsset,
  };
}

function buildPairPnl(input: {
  database: Database.Database;
  portfolioId: string;
  pair: PairAssets;
  book: OrderBookSnapshot | undefined;
  maxOrderBookAgeMs: number;
  nowMs: number;
}): PaperPnlReport {
  const realizedRows = input.database.prepare(`
    SELECT gross_pnl_quote AS grossPnlQuote
    FROM paper_realized_pnl
    WHERE portfolio_id = ? AND pair_id = ?
  `).all(input.portfolioId, input.pair.pair_id) as { grossPnlQuote: string | null }[];
  let complete = true;
  let realizedGross = new Big(0);
  for (const row of realizedRows) {
    if (row.grossPnlQuote === null) {
      complete = false;
    } else {
      realizedGross = realizedGross.plus(row.grossPnlQuote);
    }
  }

  const feeRows = input.database.prepare(`
    SELECT f.estimated_fee_xlm AS feeXlm, f.estimated_fee_quote AS feeQuote
    FROM paper_fee_entries f
    JOIN paper_orders o ON o.order_id = f.order_id
    WHERE o.portfolio_id = ? AND o.pair_id = ?
  `).all(input.portfolioId, input.pair.pair_id) as {
    feeXlm: string;
    feeQuote: string | null;
  }[];
  let feesXlm = new Big(0);
  let feesQuote = new Big(0);
  for (const fee of feeRows) {
    feesXlm = feesXlm.plus(fee.feeXlm);
    if (fee.feeQuote === null) {
      complete = false;
    } else {
      feesQuote = feesQuote.plus(fee.feeQuote);
    }
  }

  const lots = input.database.prepare(`
    SELECT remaining_base AS remainingBase, unit_cost_quote AS unitCostQuote
    FROM paper_lots
    WHERE portfolio_id = ? AND pair_id = ? AND remaining_base != '0'
  `).all(input.portfolioId, input.pair.pair_id) as {
    remainingBase: string;
    unitCostQuote: string | null;
  }[];
  const openBase = lots.reduce(
    (total, lot) => total.plus(lot.remainingBase),
    new Big(0),
  );
  let unrealizedGross: Big | null = new Big(0);
  if (openBase.gt(0)) {
    const book = input.book;
    if (
      !book
      || validateOrderBookIntegrity(book, input.maxOrderBookAgeMs, input.nowMs).length > 0
    ) {
      unrealizedGross = null;
      complete = false;
    } else {
      const proceeds = estimateExecutableVolume(book, "sell", openBase.toString());
      const basisComplete = lots.every((lot) => lot.unitCostQuote !== null);
      if (!proceeds.complete || !basisComplete) {
        unrealizedGross = null;
        complete = false;
      } else {
        const cost = lots.reduce(
          (total, lot) => total.plus(
            new Big(lot.remainingBase).times(lot.unitCostQuote ?? "0"),
          ),
          new Big(0),
        );
        unrealizedGross = new Big(proceeds.quoteAmount).minus(cost);
      }
    }
  }

  const realizedPnl = complete ? realizedGross.toString() : null;
  const unrealizedPnl = unrealizedGross?.toString() ?? null;
  const feeTotal = complete ? feesQuote.toString() : null;
  const netPnl = complete && unrealizedGross !== null
    ? realizedGross.plus(unrealizedGross).minus(feesQuote).toString()
    : null;

  return {
    pairId: input.pair.pair_id,
    quoteAssetId: input.pair.quote_asset_id,
    realizedGrossPnlQuote: realizedPnl,
    unrealizedGrossPnlQuote: unrealizedPnl,
    simulatedFeesXlm: feesXlm.toString(),
    estimatedFeesQuote: feeTotal,
    netPnlQuote: netPnl,
    complete: complete && unrealizedGross !== null,
  };
}
