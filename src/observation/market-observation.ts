import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

import { Big } from "../common/decimal.js";
import { estimateExecutableVolume } from "../order-book/executable-volume.js";
import type { OrderBookSnapshot } from "../order-book/types.js";
import type { HorizonTradePrint } from "../market-data/trade-source.js";
import { validateOrderBookIntegrity } from "../market-data/market-integrity.js";
import type { PassiveMakerSignal } from "../strategies/passive-maker.js";
import { getAssetId } from "../storage/market-store.js";
import type { TradingPairConfig } from "../config/schema.js";

const MARKOUT_HORIZONS_MINUTES = [1, 5, 15, 60] as const;
const EXECUTION_MODEL_VERSION = "public_trade_queue_bounds_v1";

interface HypotheticalOrderRow {
  hypothetical_order_id: string;
  side: "buy" | "sell";
  limit_price: string;
  requested_base: string;
  observed_at_ms: number;
  expires_at_ms: number;
  displayed_queue_ahead_base: string;
  queue_lower_bound_base: string;
  queue_upper_bound_base: string;
}

function isPositiveDecimal(value: string): boolean {
  try {
    return new Big(value).gt(0);
  } catch {
    return false;
  }
}

function advanceCursor(database: Database.Database, pairId: string, cursor: string, nowMs: number): void {
  const saved = database.prepare(`
    SELECT trade_cursor FROM stream_cursors WHERE pair_id = ?
  `).get(pairId) as { trade_cursor: string } | undefined;
  const incomingValue = /^\d+$/.test(cursor) ? BigInt(cursor) : null;
  const savedValue = saved && /^\d+$/.test(saved.trade_cursor)
    ? BigInt(saved.trade_cursor)
    : null;
  const nextCursor = !saved
    ? cursor
    : incomingValue !== null && (savedValue === null || incomingValue > savedValue)
      ? cursor
      : saved.trade_cursor;
  database.prepare(`
    INSERT INTO stream_cursors (pair_id, trade_cursor, updated_at_ms) VALUES (?, ?, ?)
    ON CONFLICT(pair_id) DO UPDATE SET trade_cursor = excluded.trade_cursor,
      updated_at_ms = excluded.updated_at_ms
  `).run(pairId, nextCursor, nowMs);
}

export function recordHypotheticalOrder(input: {
  database: Database.Database;
  decisionId: string;
  snapshotId: number;
  book: OrderBookSnapshot;
  signal: PassiveMakerSignal;
  cursor: string | null;
  nowMs?: number;
}): string | null {
  const { signal, book } = input;
  if (signal.limitPrice === null) {
    return null;
  }

  const nowMs = input.nowMs ?? Date.now();
  const queueLevels = signal.side === "buy" ? book.bids : book.asks;
  const limitPrice = new Big(signal.limitPrice);
  const displayedQueue = queueLevels.reduce((total, level) => {
    const price = new Big(level.price);
    const isAhead = signal.side === "buy"
      ? price.gte(limitPrice)
      : price.lte(limitPrice);
    return isAhead ? total.plus(level.amount) : total;
  }, new Big(0));
  const requested = new Big(signal.requestedBaseAmount);
  const id = randomUUID();
  const rejected = signal.status !== "positive";
  const reasons = [...signal.reasons];
  if (input.cursor === null) {
    reasons.push("trade_cursor_unavailable_at_placement");
  }

  input.database.transaction(() => {
    input.database.prepare(`
      INSERT INTO hypothetical_orders (
        hypothetical_order_id, decision_id, pair_id, strategy_id, side,
        limit_price, requested_base, snapshot_id, start_cursor, observed_at_ms,
        expires_at_ms,
        displayed_queue_ahead_base, queue_lower_bound_base, queue_upper_bound_base,
        status, quality_reasons_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.decisionId,
      signal.pairId,
      "passive_maker",
      signal.side,
      limitPrice.toString(),
      requested.toString(),
      input.snapshotId,
      input.cursor,
      nowMs,
      nowMs + 60 * 60_000,
      displayedQueue.toString(),
      displayedQueue.toString(),
      displayedQueue.plus(requested).toString(),
      rejected ? "rejected" : "observing",
      JSON.stringify(reasons),
    );
    input.database.prepare(`
      INSERT INTO execution_evidence (
        hypothetical_order_id, quality_status, quality_reasons_json,
        model_version, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      id,
      rejected || input.cursor === null ? "incomplete" : "unvalidated",
      JSON.stringify(reasons),
      EXECUTION_MODEL_VERSION,
      nowMs,
    );
  })();
  return id;
}

function validateTrade(trade: HorizonTradePrint, nowMs: number): string[] {
  const reasons: string[] = [];
  if (!trade.tradeId || !trade.cursor || !trade.pairId) {
    reasons.push("trade_identity_missing");
  }
  if (!isPositiveDecimal(trade.baseAmount)) {
    reasons.push("trade_base_amount_invalid");
  }
  if (!/^\d+$/.test(trade.priceNumerator) || !/^\d+$/.test(trade.priceDenominator)) {
    reasons.push("trade_rational_price_invalid");
  } else if (trade.priceNumerator === "0" || trade.priceDenominator === "0") {
    reasons.push("trade_rational_price_nonpositive");
  }
  if (!Number.isSafeInteger(trade.occurredAtMs) || trade.occurredAtMs <= 0) {
    reasons.push("trade_timestamp_invalid");
  } else if (trade.occurredAtMs > nowMs + 60_000) {
    reasons.push("trade_timestamp_in_future");
  }
  return reasons;
}

function recordMarkoutRows(input: {
  database: Database.Database;
  hypotheticalOrderId: string;
  tradeId: string;
  fillBase: Big;
  occurredAtMs: number;
  nowMs: number;
}): void {
  if (!input.fillBase.gt(0)) {
    return;
  }
  const insert = input.database.prepare(`
    INSERT OR IGNORE INTO markout_observations (
      markout_id, hypothetical_order_id, estimated_fill_trade_id, horizon_minutes,
      target_at_ms, estimated_fill_base, status, quality_reasons_json, calculated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', '[]', ?)
  `);
  for (const horizon of MARKOUT_HORIZONS_MINUTES) {
    insert.run(
      randomUUID(),
      input.hypotheticalOrderId,
      input.tradeId,
      horizon,
      input.occurredAtMs + horizon * 60_000,
      input.fillBase.toString(),
      input.nowMs,
    );
  }
}

function updateExecutionEvidence(input: {
  database: Database.Database;
  order: HypotheticalOrderRow;
  trade: HorizonTradePrint;
  price: Big;
  amount: Big;
  nowMs: number;
}): void {
  const { database, order, trade, price, amount, nowMs } = input;
  if (
    trade.occurredAtMs <= order.observed_at_ms
    || trade.occurredAtMs > order.expires_at_ms
  ) {
    return;
  }
  const matchingSide = order.side === "buy" ? trade.baseIsSeller : !trade.baseIsSeller;
  if (!matchingSide) {
    return;
  }
  const limit = new Big(order.limit_price);
  const exact = price.eq(limit);
  const through = order.side === "buy" ? price.lt(limit) : price.gt(limit);
  if (!exact && !through) {
    return;
  }

  const priorRows = database.prepare(`
    SELECT exact_price_volume_base AS volume
    FROM hypothetical_trade_evidence
    WHERE hypothetical_order_id = ? AND attribution = 'exact_price_observed'
  `).all(order.hypothetical_order_id) as { volume: string }[];
  const priorExactVolume = priorRows.reduce(
    (total, row) => total.plus(row.volume),
    new Big(0),
  );
  const priorLowerFill = priorExactVolume
    .minus(order.queue_upper_bound_base)
    .gt(0)
    ? priorExactVolume.minus(order.queue_upper_bound_base)
    : new Big(0);
  const priorUpperFill = priorExactVolume
    .minus(order.queue_lower_bound_base)
    .gt(0)
    ? priorExactVolume.minus(order.queue_lower_bound_base)
    : new Big(0);
  const totalExact = exact ? priorExactVolume.plus(amount) : priorExactVolume;
  const lowerFill = totalExact
    .minus(order.queue_upper_bound_base)
    .gt(0)
    ? totalExact.minus(order.queue_upper_bound_base)
    : new Big(0);
  const upperFill = totalExact
    .minus(order.queue_lower_bound_base)
    .gt(0)
    ? totalExact.minus(order.queue_lower_bound_base)
    : new Big(0);
  const requested = new Big(order.requested_base);
  const boundedLower = lowerFill.gt(requested) ? requested : lowerFill;
  const boundedUpper = upperFill.gt(requested) ? requested : upperFill;
  const priorBoundedLower = priorLowerFill.gt(requested) ? requested : priorLowerFill;
  const priorBoundedUpper = priorUpperFill.gt(requested) ? requested : priorUpperFill;
  const lowerIncrement = boundedLower.minus(priorBoundedLower);
  const upperIncrement = boundedUpper.minus(priorBoundedUpper);
  const exactVolume = exact ? amount : new Big(0);
  const throughVolume = through ? amount : new Big(0);

  const inserted = database.prepare(`
    INSERT OR IGNORE INTO hypothetical_trade_evidence (
      hypothetical_order_id, trade_id, observed_at_ms, trade_price,
      exact_price_volume_base, through_price_volume_base,
      estimated_fill_lower_base, estimated_fill_upper_base, attribution
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    order.hypothetical_order_id,
    trade.tradeId,
    trade.occurredAtMs,
    price.toString(),
    exactVolume.toString(),
    throughVolume.toString(),
    lowerIncrement.toString(),
    upperIncrement.toString(),
    exact ? "exact_price_observed" : "through_price_observed",
  );
  if (inserted.changes === 0) {
    return;
  }

  const allEvidence = database.prepare(`
    SELECT exact_price_volume_base AS exactVolume,
      through_price_volume_base AS throughVolume,
      estimated_fill_lower_base AS lowerFill,
      estimated_fill_upper_base AS upperFill
    FROM hypothetical_trade_evidence WHERE hypothetical_order_id = ?
  `).all(order.hypothetical_order_id) as {
    exactVolume: string;
    throughVolume: string;
    lowerFill: string;
    upperFill: string;
  }[];
  const exactTotal = allEvidence.reduce(
    (total, row) => total.plus(row.exactVolume),
    new Big(0),
  );
  const throughTotal = allEvidence.reduce(
    (total, row) => total.plus(row.throughVolume),
    new Big(0),
  );
  const orderFilledLower = allEvidence.reduce(
    (total, row) => total.plus(row.lowerFill),
    new Big(0),
  );
  const orderFilledUpper = allEvidence.reduce(
    (total, row) => total.plus(row.upperFill),
    new Big(0),
  );
  const lowerProbability = boundedLower.gt(0) ? "1" : "0";
  const upperProbability = boundedUpper.gt(0) ? "1" : "0";
  const partialLower = boundedLower.gt(0) && boundedUpper.lt(requested) ? "1" : "0";
  const partialUpper = boundedUpper.gt(0) && boundedLower.lt(requested) ? "1" : "0";

  database.prepare(`
    UPDATE execution_evidence SET
      exact_price_volume_base = ?, through_price_volume_base = ?,
      estimated_fill_lower_base = ?, estimated_fill_upper_base = ?,
      estimated_fill_probability_lower = ?, estimated_fill_probability_upper = ?,
      partial_fill_probability_lower = ?, partial_fill_probability_upper = ?,
      observed_trade_count = ?, quality_status = 'incomplete',
      quality_reasons_json = ?, updated_at_ms = ?
    WHERE hypothetical_order_id = ?
  `).run(
    exactTotal.toString(),
    throughTotal.toString(),
    boundedLower.toString(),
    boundedUpper.toString(),
    lowerProbability,
    upperProbability,
    partialLower,
    partialUpper,
    allEvidence.length,
    JSON.stringify(["queue_position_is_unobservable", "public_trades_do_not_prove_our_execution"]),
    nowMs,
    order.hypothetical_order_id,
  );
  recordMarkoutRows({
    database,
    hypotheticalOrderId: order.hypothetical_order_id,
    tradeId: trade.tradeId,
    fillBase: lowerIncrement,
    occurredAtMs: trade.occurredAtMs,
    nowMs,
  });
  if (orderFilledLower.gt(0) || orderFilledUpper.gt(0)) {
    database.prepare(`
      UPDATE hypothetical_orders SET status = 'incomplete'
      WHERE hypothetical_order_id = ?
    `).run(order.hypothetical_order_id);
  }
}

export function recordObservedTrade(input: {
  database: Database.Database;
  trade: HorizonTradePrint;
  source?: "horizon_sse" | "horizon_rest_backfill";
  nowMs?: number;
}): { duplicate: boolean; validationReasons: string[] } {
  const nowMs = input.nowMs ?? Date.now();
  const trade = input.trade;
  const validationReasons = validateTrade(trade, nowMs);
  return input.database.transaction(() => {
    const sequence = input.database.prepare(`
      SELECT COALESCE(MAX(received_sequence), 0) + 1 AS nextSequence
      FROM market_trades WHERE pair_id = ?
    `).get(trade.pairId) as { nextSequence: number };
    const inserted = input.database.prepare(`
      INSERT OR IGNORE INTO market_trades (
        trade_id, pair_id, cursor, occurred_at_ms, base_amount, price_numerator,
        price_denominator, base_is_seller, trade_type, source, received_at_ms,
        received_sequence, validation_status, validation_reasons_json, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      trade.tradeId,
      trade.pairId,
      trade.cursor,
      trade.occurredAtMs,
      trade.baseAmount,
      trade.priceNumerator,
      trade.priceDenominator,
      trade.baseIsSeller ? 1 : 0,
      trade.tradeType,
      input.source ?? "horizon_sse",
      trade.receivedAtMs ?? nowMs,
      sequence.nextSequence,
      validationReasons.length === 0 ? "valid" : "quarantined",
      JSON.stringify(validationReasons),
      JSON.stringify(trade),
    );
    if (inserted.changes === 0) {
      const previous = input.database.prepare(`
        SELECT pair_id AS pairId, cursor, occurred_at_ms AS occurredAtMs,
          base_amount AS baseAmount, price_numerator AS priceNumerator,
          price_denominator AS priceDenominator, base_is_seller AS baseIsSeller,
          trade_type AS tradeType
        FROM market_trades WHERE trade_id = ?
      `).get(trade.tradeId) as {
        pairId: string;
        cursor: string;
        occurredAtMs: number;
        baseAmount: string;
        priceNumerator: string;
        priceDenominator: string;
        baseIsSeller: number;
        tradeType: string;
      } | undefined;
      if (
        previous
        && (
          previous.pairId !== trade.pairId
          || previous.cursor !== trade.cursor
          || previous.occurredAtMs !== trade.occurredAtMs
          || previous.baseAmount !== trade.baseAmount
          || previous.priceNumerator !== trade.priceNumerator
          || previous.priceDenominator !== trade.priceDenominator
          || previous.baseIsSeller !== Number(trade.baseIsSeller)
          || previous.tradeType !== trade.tradeType
        )
      ) {
        validationReasons.push("duplicate_trade_payload_conflict");
        input.database.prepare(`
          UPDATE market_trades
          SET validation_status = 'quarantined', validation_reasons_json = ?
          WHERE trade_id = ?
        `).run(JSON.stringify(validationReasons), trade.tradeId);
        input.database.prepare(`
          UPDATE hypothetical_orders
          SET status = 'incomplete', quality_reasons_json = ?
          WHERE hypothetical_order_id IN (
            SELECT hypothetical_order_id FROM hypothetical_trade_evidence
            WHERE trade_id = ?
          )
        `).run(JSON.stringify(validationReasons), trade.tradeId);
        input.database.prepare(`
          UPDATE execution_evidence
          SET quality_status = 'incomplete', quality_reasons_json = ?, updated_at_ms = ?
          WHERE hypothetical_order_id IN (
            SELECT hypothetical_order_id FROM hypothetical_trade_evidence
            WHERE trade_id = ?
          )
        `).run(JSON.stringify(validationReasons), nowMs, trade.tradeId);
        input.database.prepare(`
          UPDATE markout_observations
          SET status = 'invalid', quality_reasons_json = ?, calculated_at_ms = ?
          WHERE estimated_fill_trade_id = ?
        `).run(JSON.stringify(validationReasons), nowMs, trade.tradeId);
        return { duplicate: true, validationReasons };
      }
      if (trade.pairId && trade.cursor) {
        advanceCursor(input.database, trade.pairId, trade.cursor, nowMs);
      }
      return { duplicate: true, validationReasons };
    }
    if (trade.pairId && trade.cursor) {
      advanceCursor(input.database, trade.pairId, trade.cursor, nowMs);
    }

    if (validationReasons.length === 0 && trade.tradeType === "orderbook") {
      const orders = input.database.prepare(`
        SELECT hypothetical_order_id, side, limit_price, requested_base,
          observed_at_ms, expires_at_ms, displayed_queue_ahead_base, queue_lower_bound_base,
          queue_upper_bound_base
        FROM hypothetical_orders
        WHERE pair_id = ? AND status IN ('observing', 'incomplete')
          AND observed_at_ms < ?
      `).all(trade.pairId, trade.occurredAtMs) as HypotheticalOrderRow[];
      const tradePrice = new Big(trade.priceNumerator).div(trade.priceDenominator);
      const amount = new Big(trade.baseAmount);
      for (const order of orders) {
        updateExecutionEvidence({
          database: input.database,
          order,
          trade,
          price: tradePrice,
          amount,
          nowMs,
        });
      }
    }
    return { duplicate: false, validationReasons };
  }).immediate();
}

function netFeeEstimate(database: Database.Database, orderId: string, fillBase: Big): Big | null {
  const row = database.prepare(`
    SELECT d.fee_estimate_json AS feeEstimate, h.requested_base AS requestedBase
    FROM hypothetical_orders h
    JOIN strategy_decisions d ON d.decision_id = h.decision_id
    WHERE h.hypothetical_order_id = ?
  `).get(orderId) as { feeEstimate: string; requestedBase: string } | undefined;
  if (!row) {
    throw new Error(`Unknown hypothetical order ${orderId}`);
  }
  const estimate: unknown = JSON.parse(row.feeEstimate);
  if (
    typeof estimate !== "object"
    || estimate === null
    || !("networkFeeQuote" in estimate)
    || typeof estimate.networkFeeQuote !== "string"
    || !isPositiveDecimal(estimate.networkFeeQuote)
  ) {
    return null;
  }
  return new Big(estimate.networkFeeQuote).times(fillBase).div(row.requestedBase);
}

export function updateMaturedMarkouts(input: {
  database: Database.Database;
  book: OrderBookSnapshot;
  snapshotId: number;
  maxOrderBookAgeMs: number;
  nowMs?: number;
}): number {
  const nowMs = input.nowMs ?? Date.now();
  const pending = input.database.prepare(`
    SELECT m.markout_id, m.hypothetical_order_id, m.estimated_fill_trade_id,
      m.estimated_fill_base, h.side, h.limit_price
    FROM markout_observations m
    JOIN hypothetical_orders h USING (hypothetical_order_id)
    WHERE m.status = 'pending' AND m.target_at_ms <= ?
      AND h.pair_id = ? AND ? >= m.target_at_ms
  `).all(input.book.receivedAtMs, input.book.pairId, input.book.receivedAtMs) as {
    markout_id: string;
    hypothetical_order_id: string;
    estimated_fill_trade_id: string;
    estimated_fill_base: string;
    side: "buy" | "sell";
    limit_price: string;
  }[];
  if (pending.length === 0) {
    return 0;
  }

  const integrityReasons = validateOrderBookIntegrity(
    input.book,
    input.maxOrderBookAgeMs,
    nowMs,
  );
  for (const markout of pending) {
    if (integrityReasons.length > 0) {
      input.database.prepare(`
        UPDATE markout_observations
        SET quality_reasons_json = ?, calculated_at_ms = ?
        WHERE markout_id = ?
      `).run(JSON.stringify(integrityReasons), nowMs, markout.markout_id);
      continue;
    }
    const liquidationSide = markout.side === "buy" ? "sell" : "buy";
    const liquidation = estimateExecutableVolume(
      input.book,
      liquidationSide,
      markout.estimated_fill_base,
    );
    if (!liquidation.complete || liquidation.averagePrice === null) {
      input.database.prepare(`
        UPDATE markout_observations
        SET status = 'incomplete', selected_snapshot_id = ?,
          quality_reasons_json = ?, calculated_at_ms = ?
        WHERE markout_id = ?
      `).run(
        input.snapshotId,
        JSON.stringify(["insufficient_executable_liquidation_depth"]),
        nowMs,
        markout.markout_id,
      );
      continue;
    }

    const quantity = new Big(markout.estimated_fill_base);
    const entryValue = quantity.times(markout.limit_price);
    const gross = markout.side === "buy"
      ? new Big(liquidation.quoteAmount).minus(entryValue)
      : entryValue.minus(new Big(liquidation.quoteAmount));
    const fee = netFeeEstimate(input.database, markout.hypothetical_order_id, quantity);
    input.database.prepare(`
      UPDATE markout_observations
      SET selected_snapshot_id = ?, liquidation_quote = ?, markout_gross_quote = ?,
        estimated_exit_fee_quote = ?, markout_net_quote = ?, status = ?,
        quality_reasons_json = ?, calculated_at_ms = ?
      WHERE markout_id = ?
    `).run(
      input.snapshotId,
      liquidation.quoteAmount,
      gross.toString(),
      fee?.toString() ?? null,
      fee === null ? null : gross.minus(fee).toString(),
      fee === null ? "incomplete" : "complete",
      JSON.stringify(fee === null ? ["simulated_fee_conversion_unavailable"] : []),
      nowMs,
      markout.markout_id,
    );
  }
  return pending.length;
}

export function completeExpiredHypotheticalOrders(input: {
  database: Database.Database;
  pairId: string;
  observedAtMs: number;
  nowMs?: number;
}): { complete: number; incomplete: number } {
  const nowMs = input.nowMs ?? Date.now();
  const expired = input.database.prepare(`
    SELECT hypothetical_order_id AS id, expires_at_ms AS expiresAtMs,
      start_cursor AS startCursor
    FROM hypothetical_orders
    WHERE pair_id = ? AND status = 'observing' AND expires_at_ms <= ?
  `).all(input.pairId, input.observedAtMs) as {
    id: string;
    expiresAtMs: number;
    startCursor: string | null;
  }[];
  let complete = 0;
  let incomplete = 0;
  for (const order of expired) {
    const gap = order.startCursor === null || input.database.prepare(`
      SELECT 1 FROM market_data_gaps
      WHERE pair_id = ? AND detected_at_ms <= ?
        AND status IN ('open', 'backfilling', 'unrecoverable')
      LIMIT 1
    `).get(input.pairId, order.expiresAtMs);
    if (gap) {
      const reason = order.startCursor === null
        ? "trade_cursor_unavailable_at_placement"
        : "unresolved_market_data_gap_during_observation";
      input.database.prepare(`
        UPDATE hypothetical_orders
        SET status = 'incomplete', quality_reasons_json = ?
        WHERE hypothetical_order_id = ?
      `).run(JSON.stringify([reason]), order.id);
      input.database.prepare(`
        UPDATE execution_evidence
        SET quality_status = 'incomplete', quality_reasons_json = ?, updated_at_ms = ?
        WHERE hypothetical_order_id = ?
      `).run(
        JSON.stringify([reason]),
        nowMs,
        order.id,
      );
      incomplete += 1;
      continue;
    }

    input.database.prepare(`
      UPDATE hypothetical_orders SET status = 'complete'
      WHERE hypothetical_order_id = ?
    `).run(order.id);
    input.database.prepare(`
      UPDATE execution_evidence
      SET quality_status = 'complete', estimated_fill_probability_lower =
        COALESCE(estimated_fill_probability_lower, '0'),
        estimated_fill_probability_upper = COALESCE(estimated_fill_probability_upper, '0'),
        partial_fill_probability_lower = COALESCE(partial_fill_probability_lower, '0'),
        partial_fill_probability_upper = COALESCE(partial_fill_probability_upper, '0'),
        quality_reasons_json = ?, updated_at_ms = ?
      WHERE hypothetical_order_id = ? AND quality_status = 'unvalidated'
    `).run(JSON.stringify([]), nowMs, order.id);
    complete += 1;
  }
  return { complete, incomplete };
}

export function openTradeStreamSession(input: {
  database: Database.Database;
  pairId: string;
  source: string;
  cursor: string | null;
  nowMs?: number;
}): string {
  const id = randomUUID();
  input.database.prepare(`
    INSERT INTO market_stream_sessions (
      session_id, pair_id, source, started_at_ms, status, start_cursor
    ) VALUES (?, ?, ?, ?, 'connecting', ?)
  `).run(id, input.pairId, input.source, input.nowMs ?? Date.now(), input.cursor);
  return id;
}

export function recordTradeStreamGap(input: {
  database: Database.Database;
  pairId: string;
  sessionId: string;
  source: string;
  fromCursor: string | null;
  reason: string;
  nowMs?: number;
}): string {
  const id = randomUUID();
  input.database.prepare(`
    INSERT INTO market_data_gaps (
      gap_id, pair_id, session_id, source, detected_at_ms, from_cursor,
      status, reason
    ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)
  `).run(
    id,
    input.pairId,
    input.sessionId,
    input.source,
    input.nowMs ?? Date.now(),
    input.fromCursor,
    input.reason,
  );
  input.database.prepare(`
    UPDATE market_stream_sessions
    SET status = 'degraded', error = ?, ended_at_ms = ?
    WHERE session_id = ?
  `).run(input.reason, input.nowMs ?? Date.now(), input.sessionId);
  return id;
}

export function resolveTradeStreamGap(input: {
  database: Database.Database;
  gapId: string;
  toCursor: string;
  recoveredEventCount: number;
  nowMs?: number;
}): void {
  input.database.prepare(`
    UPDATE market_data_gaps
    SET status = 'resolved', resolved_at_ms = ?, to_cursor = ?,
      recovered_event_count = ?, error = NULL
    WHERE gap_id = ? AND status IN ('open', 'backfilling')
  `).run(
    input.nowMs ?? Date.now(),
    input.toCursor,
    input.recoveredEventCount,
    input.gapId,
  );
}

export function resolveOpenTradeStreamGaps(input: {
  database: Database.Database;
  pairId: string;
  toCursor: string;
  recoveredEventCount: number;
  nowMs?: number;
}): number {
  const result = input.database.prepare(`
    UPDATE market_data_gaps
    SET status = 'resolved', resolved_at_ms = ?, to_cursor = ?,
      recovered_event_count = ?, error = NULL
    WHERE pair_id = ? AND status IN ('open', 'backfilling')
  `).run(
    input.nowMs ?? Date.now(),
    input.toCursor,
    input.recoveredEventCount,
    input.pairId,
  );
  return result.changes;
}

export interface TradeBackfillSource {
  catchUp(
    pair: TradingPairConfig,
    cursor: string,
    onTrade: (trade: HorizonTradePrint) => void,
  ): Promise<{ count: number; lastCursor: string }>;
}

export async function backfillObservedTrades(input: {
  database: Database.Database;
  source: TradeBackfillSource;
  pair: TradingPairConfig;
  pairId: string;
  sessionId: string;
  cursor: string;
  nowMs?: number;
  onValidationIssue?: (trade: HorizonTradePrint, reasons: string[]) => void;
}): Promise<{ count: number; lastCursor: string }> {
  const nowMs = input.nowMs ?? Date.now();
  input.database.prepare(`
    UPDATE market_data_gaps SET status = 'backfilling'
    WHERE pair_id = ? AND status = 'open'
  `).run(input.pairId);
  input.database.prepare(`
    UPDATE market_stream_sessions SET status = 'backfilling'
    WHERE session_id = ?
  `).run(input.sessionId);
  try {
    const result = await input.source.catchUp(input.pair, input.cursor, (trade) => {
      const observed = recordObservedTrade({
        database: input.database,
        trade,
        source: "horizon_rest_backfill",
        nowMs,
      });
      if (observed.validationReasons.length > 0) {
        input.onValidationIssue?.(trade, observed.validationReasons);
      }
    });
    resolveOpenTradeStreamGaps({
      database: input.database,
      pairId: input.pairId,
      toCursor: result.lastCursor,
      recoveredEventCount: result.count,
      nowMs,
    });
    return result;
  } catch (error) {
    input.database.prepare(`
      UPDATE market_data_gaps
      SET status = 'open', error = ?
      WHERE pair_id = ? AND status = 'backfilling'
    `).run(error instanceof Error ? error.message : "trade_backfill_failed", input.pairId);
    throw error;
  }
}

export function recordPortfolioValuation(input: {
  database: Database.Database;
  portfolioId: string;
  pair: TradingPairConfig;
  book: OrderBookSnapshot | undefined;
  snapshotId: number | undefined;
  maxOrderBookAgeMs: number;
  nowMs?: number;
}): {
  status: "complete" | "incomplete";
  dailyNetPnlQuote: string | null;
  maximumDrawdownQuote: string | null;
  reasons: string[];
} {
  const nowMs = input.nowMs ?? Date.now();
  const pairId = `${getAssetId(input.pair.base) === "native" ? "XLM" : getAssetId(input.pair.base)}/${
    getAssetId(input.pair.quote) === "native" ? "XLM" : getAssetId(input.pair.quote)
  }`;
  const baseAssetId = getAssetId(input.pair.base);
  const quoteAssetId = getAssetId(input.pair.quote);
  const balance = input.database.prepare(`
    SELECT available, reserved FROM paper_balances
    WHERE portfolio_id = ? AND asset_id = ?
  `).get(input.portfolioId, quoteAssetId) as {
    available: string;
    reserved: string;
  } | undefined;
  const quoteCash = new Big(balance?.available ?? "0").plus(balance?.reserved ?? "0");
  const baseBalance = input.database.prepare(`
    SELECT available, reserved FROM paper_balances
    WHERE portfolio_id = ? AND asset_id = ?
  `).get(input.portfolioId, baseAssetId) as {
    available: string;
    reserved: string;
  } | undefined;
  const inventoryBase = new Big(baseBalance?.available ?? "0")
    .plus(baseBalance?.reserved ?? "0");
  const lots = input.database.prepare(`
    SELECT remaining_base AS remainingBase, unit_cost_quote AS unitCostQuote
    FROM paper_lots
    WHERE portfolio_id = ? AND pair_id = ? AND remaining_base != '0'
  `).all(input.portfolioId, pairId) as {
    remainingBase: string;
    unitCostQuote: string | null;
  }[];
  const lotInventory = lots.reduce(
    (total, lot) => total.plus(lot.remainingBase),
    new Big(0),
  );
  const reasons: string[] = [];
  let costBasis: Big | null = new Big(0);
  for (const lot of lots) {
    if (lot.unitCostQuote === null) {
      costBasis = null;
      reasons.push("inventory_cost_basis_unavailable");
      break;
    }
    if (costBasis !== null) {
      costBasis = costBasis.plus(new Big(lot.remainingBase).times(lot.unitCostQuote));
    }
  }
  if (inventoryBase.gt(lotInventory)) {
    costBasis = null;
    reasons.push("inventory_exceeds_known_lot_basis");
  } else if (inventoryBase.lt(lotInventory)) {
    if (baseAssetId !== "native") {
      costBasis = null;
      reasons.push("inventory_lot_balance_mismatch");
    } else {
      const nativeFees = input.database.prepare(`
        SELECT f.estimated_fee_xlm AS feeXlm
        FROM paper_fee_entries f
        JOIN paper_orders o ON o.order_id = f.order_id
        WHERE o.portfolio_id = ?
      `).all(input.portfolioId) as { feeXlm: string }[];
      const totalNativeFees = nativeFees.reduce(
        (total, fee) => total.plus(fee.feeXlm),
        new Big(0),
      );
      if (lotInventory.minus(inventoryBase).gt(totalNativeFees)) {
        costBasis = null;
        reasons.push("inventory_lot_balance_mismatch");
      } else if (costBasis !== null && lotInventory.gt(0)) {
        costBasis = costBasis.times(inventoryBase).div(lotInventory);
      }
    }
  }

  let liquidationQuote: Big | null = new Big(0);
  if (inventoryBase.gt(0)) {
    if (
      !input.book
      || validateOrderBookIntegrity(input.book, input.maxOrderBookAgeMs, nowMs).length > 0
    ) {
      liquidationQuote = null;
      reasons.push("conservative_liquidation_book_unavailable_or_stale");
    } else {
      const liquidation = estimateExecutableVolume(
        input.book,
        "sell",
        inventoryBase.toString(),
      );
      if (!liquidation.complete) {
        liquidationQuote = null;
        reasons.push("insufficient_executable_liquidation_depth");
      } else {
        liquidationQuote = new Big(liquidation.quoteAmount);
      }
    }
  }

  const date = new Date(nowMs);
  const dayStartMs = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const realized = input.database.prepare(`
    SELECT gross_pnl_quote AS grossPnl
    FROM paper_realized_pnl
    WHERE portfolio_id = ? AND quote_asset_id = ?
      AND created_at_ms >= ? AND created_at_ms <= ?
  `).all(input.portfolioId, quoteAssetId, dayStartMs, nowMs) as {
    grossPnl: string | null;
  }[];
  let realizedNet: Big | null = new Big(0);
  for (const row of realized) {
    if (row.grossPnl === null) {
      realizedNet = null;
      reasons.push("realized_pnl_incomplete");
      break;
    }
    realizedNet = realizedNet.plus(row.grossPnl);
  }
  const fees = input.database.prepare(`
    SELECT estimated_fee_quote AS feeQuote
    FROM paper_fee_entries f
    JOIN paper_orders o ON o.order_id = f.order_id
    WHERE o.portfolio_id = ? AND f.quote_asset_id = ?
      AND f.created_at_ms >= ? AND f.created_at_ms <= ?
  `).all(input.portfolioId, quoteAssetId, dayStartMs, nowMs) as {
    feeQuote: string | null;
  }[];
  for (const fee of fees) {
    if (fee.feeQuote === null) {
      realizedNet = null;
      reasons.push("simulated_fee_conversion_incomplete");
      break;
    }
    if (realizedNet !== null) {
      realizedNet = realizedNet.minus(fee.feeQuote);
    }
  }

  const unrealized = liquidationQuote !== null && costBasis !== null
    ? liquidationQuote.minus(costBasis)
    : null;
  const dailyNet = realizedNet !== null && unrealized !== null
    ? realizedNet.plus(unrealized)
    : null;
  if (dailyNet === null && reasons.length === 0) {
    reasons.push("daily_pnl_incomplete");
  }
  const priorValuations = input.database.prepare(`
    SELECT daily_net_pnl_quote AS dailyNetPnl
    FROM portfolio_valuation_snapshots
    WHERE portfolio_id = ? AND pair_id = ? AND observed_at_ms >= ?
      AND valuation_status = 'complete' AND daily_net_pnl_quote IS NOT NULL
  `).all(input.portfolioId, pairId, dayStartMs) as {
    dailyNetPnl: string;
  }[];
  let peak = new Big(0);
  for (const prior of priorValuations) {
    const priorPnl = new Big(prior.dailyNetPnl);
    if (priorPnl.gt(peak)) {
      peak = priorPnl;
    }
  }
  const drawdown = dailyNet === null
    ? null
    : peak.minus(dailyNet).gt(0) ? peak.minus(dailyNet) : new Big(0);
  const status = reasons.length === 0 ? "complete" : "incomplete";
  input.database.prepare(`
    INSERT INTO portfolio_valuation_snapshots (
      valuation_id, portfolio_id, pair_id, quote_asset_id, snapshot_id,
      observed_at_ms, quote_cash, inventory_base, inventory_liquidation_quote,
      inventory_cost_basis_quote, realized_net_pnl_today_quote,
      unrealized_net_pnl_quote, daily_net_pnl_quote, inventory_exposure_quote,
      maximum_drawdown_quote, valuation_status, quality_reasons_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    input.portfolioId,
    pairId,
    quoteAssetId,
    input.snapshotId ?? null,
    nowMs,
    quoteCash.toString(),
    inventoryBase.toString(),
    liquidationQuote?.toString() ?? null,
    costBasis?.toString() ?? null,
    realizedNet?.toString() ?? null,
    unrealized?.toString() ?? null,
    dailyNet?.toString() ?? null,
    liquidationQuote?.toString() ?? null,
    drawdown?.toString() ?? null,
    status,
    JSON.stringify(reasons),
  );
  return {
    status,
    dailyNetPnlQuote: dailyNet?.toString() ?? null,
    maximumDrawdownQuote: drawdown?.toString() ?? null,
    reasons,
  };
}
