import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

import { Big } from "../common/decimal.js";
import { compareHorizonCursors } from "../common/horizon-cursor.js";
import { estimateExecutableVolume } from "../order-book/executable-volume.js";
import type { OrderBookSnapshot } from "../order-book/types.js";

export const HISTORICAL_REPLAY_MODEL_VERSION = "historical_queue_replay_v5";
export const REPLAY_MARKOUT_HORIZONS_SECONDS = [5, 30, 60, 300, 900] as const;
export const REPLAY_EXECUTION_MODE = "independent_counterfactual" as const;
const TRADE_EVENT_TIME_SAFETY_MS = 1_000;
const MAX_ORDER_BOOK_SNAPSHOT_GAP_MS = 5 * 60_000;

interface CandidateRow {
  decisionId: string;
  sourceOrderId: string;
  pairId: string;
  strategyId: string;
  side: "buy" | "sell";
  decisionStatus: "positive" | "insufficient_data";
  limitPrice: string;
  requestedBase: string;
  placementAtMs: number;
  expiresAtMs: number;
  snapshotId: number;
  snapshotReceivedAtMs: number;
  snapshotJson: string;
  snapshotIntegrity: "valid" | "rejected";
  initialQueue: string;
  initialQueueLower: string;
  initialQueueUpper: string;
  cursor: string | null;
  feeEstimateJson: string;
}

interface SnapshotRow {
  id: number;
  pairId: string;
  receivedAtMs: number;
  receivedSequence: number | null;
  snapshotJson: string;
  contentHash: string;
  integrityStatus: "valid" | "rejected";
}

interface TradeRow {
  tradeId: string;
  pairId: string;
  cursor: string;
  occurredAtMs: number;
  receivedAtMs: number;
  receivedSequence: number | null;
  baseAmount: string;
  priceNumerator: string;
  priceDenominator: string;
  baseIsSeller: number;
  tradeType: string;
  validationStatus: "valid" | "rejected" | "quarantined" | "unverified";
}

interface GapRow {
  pairId: string;
  detectedAtMs: number;
  resolvedAtMs: number | null;
  status: "open" | "backfilling" | "resolved" | "unrecoverable";
}

interface ReplayEvent {
  observedAtMs: number;
  kind: "snapshot" | "trade";
  key: string;
  snapshot?: SnapshotRow;
  trade?: TradeRow;
}

interface FillEvent {
  trade: TradeRow;
  lower: Big;
  upper: Big;
  queueLowerBefore: Big;
  queueUpperBefore: Big;
  classification:
    | "confirmed_public_trade_evidence"
    | "modeled_fill_estimate"
    | "uncertain_fill"
    | "no_fill_evidence";
  reasons: string[];
}

interface ScenarioResult {
  scenarioId: string;
  candidate: CandidateRow;
  status: "modeled_fill" | "partial_fill" | "no_fill_evidence" | "uncertain" | "incomplete";
  fillLower: Big;
  fillUpper: Big;
  remainingLower: Big;
  remainingUpper: Big;
  firstFillAtMs: number | null;
  evidenceQuality: "sufficient" | "uncertain" | "incomplete";
  confidence: "high" | "medium" | "low" | "none";
  reasons: string[];
  events: FillEvent[];
  markouts: MarkoutResult[];
}

interface MarkoutResult {
  fill: FillEvent;
  horizonSeconds: number;
  fillReferenceSnapshot: SnapshotRow | null;
  fillReferenceAtMs: number | null;
  fillReferenceDeviationMs: number | null;
  targetAtMs: number;
  sampledSnapshot: SnapshotRow | null;
  sampledAtMs: number | null;
  deviationMs: number | null;
  status: "complete" | "pending" | "incomplete" | "invalid";
  spreadCaptureQuote: string | null;
  priceMovementQuote: string | null;
  liquidationImpactQuote: string | null;
  feesQuote: string | null;
  netQuote: string | null;
  reasons: string[];
}

export interface HistoricalReplaySummary {
  replayRunId: string;
  modelVersion: string;
  executionMode: typeof REPLAY_EXECUTION_MODE;
  scenarioCount: number;
  completeObservationWindowCount: number;
  scenarioStatuses: Record<ScenarioResult["status"], number>;
  evidenceQuality: Record<ScenarioResult["evidenceQuality"], number>;
  qualityReasonCounts: Array<{ reason: string; count: number }>;
  fillEvidence: {
    modeledFillEvents: number;
    uncertainFillEvents: number;
    scenariosWithLowerBoundFill: number;
    scenariosWithPossibleFill: number;
    scenariosWithPartialLowerBoundFill: number;
  };
  modeledFillCount: number;
  partialFillCount: number;
  markoutsByHorizon: Array<{
    horizonSeconds: number;
    complete: number;
    pending: number;
    incomplete: number;
    invalid: number;
  }>;
  portfolioSimulationImplemented: false;
  independentExperimentsMustNotBeSummedAsPortfolioPnl: true;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseBook(value: string): OrderBookSnapshot {
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== "object"
    || parsed === null
    || !("pairId" in parsed)
    || typeof parsed.pairId !== "string"
    || !("bids" in parsed)
    || !Array.isArray(parsed.bids)
    || !("asks" in parsed)
    || !Array.isArray(parsed.asks)
  ) {
    throw new Error("Persisted order-book snapshot is malformed");
  }
  return parsed as OrderBookSnapshot;
}

function queueAtPrice(book: OrderBookSnapshot, side: "buy" | "sell", limitPrice: string): {
  better: Big;
  same: Big;
} {
  const levels = side === "buy" ? book.bids : book.asks;
  let better = new Big(0);
  let same = new Big(0);
  for (const level of levels) {
    const price = new Big(level.price);
    const ahead = side === "buy" ? price.gt(limitPrice) : price.lt(limitPrice);
    if (ahead) {
      better = better.plus(level.amount);
    } else if (price.eq(limitPrice)) {
      same = same.plus(level.amount);
    }
  }
  return { better, same };
}

function compareCursor(left: string, right: string): number | null {
  return compareHorizonCursors(left, right);
}

function maxBig(left: Big, right: Big): Big {
  return left.gte(right) ? left : right;
}

function minBig(left: Big, right: Big): Big {
  return left.lte(right) ? left : right;
}

function firstIndexAfter<T>(
  values: T[],
  timeMs: number,
  timestamp: (value: T) => number,
): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const value = values[middle];
    if (value !== undefined && timestamp(value) <= timeMs) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function firstIndexAtOrAfter<T>(
  values: T[],
  timeMs: number,
  timestamp: (value: T) => number,
): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const value = values[middle];
    if (value !== undefined && timestamp(value) < timeMs) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function loadInputs(database: Database.Database): {
  candidates: CandidateRow[];
  snapshots: SnapshotRow[];
  trades: TradeRow[];
  gaps: GapRow[];
  fingerprint: string;
} {
  const candidates = database.prepare(`
    SELECT d.decision_id AS decisionId, h.hypothetical_order_id AS sourceOrderId,
      d.pair_id AS pairId, d.strategy_id AS strategyId, d.side, d.status AS decisionStatus,
      h.limit_price AS limitPrice, h.requested_base AS requestedBase,
      h.observed_at_ms AS placementAtMs, h.expires_at_ms AS expiresAtMs, s.id AS snapshotId,
      s.received_at_ms AS snapshotReceivedAtMs, s.snapshot_json AS snapshotJson,
      s.integrity_status AS snapshotIntegrity,
      h.displayed_queue_ahead_base AS initialQueue,
      h.queue_lower_bound_base AS initialQueueLower,
      h.queue_upper_bound_base AS initialQueueUpper,
      h.start_cursor AS cursor, d.fee_estimate_json AS feeEstimateJson
    FROM strategy_decisions d
    JOIN hypothetical_orders h ON h.decision_id = d.decision_id
    JOIN market_snapshots s ON s.id = h.snapshot_id
    WHERE d.status IN ('positive', 'insufficient_data')
    ORDER BY d.created_at_ms, d.decision_id
  `).all() as CandidateRow[];
  const snapshots = database.prepare(`
    SELECT id, pair_id AS pairId, received_at_ms AS receivedAtMs,
      received_sequence AS receivedSequence, snapshot_json AS snapshotJson,
      content_hash AS contentHash, integrity_status AS integrityStatus
    FROM market_snapshots
    ORDER BY pair_id, received_at_ms, received_sequence, id
  `).all() as SnapshotRow[];
  const trades = database.prepare(`
    SELECT trade_id AS tradeId, pair_id AS pairId, cursor,
      occurred_at_ms AS occurredAtMs, received_at_ms AS receivedAtMs,
      received_sequence AS receivedSequence, base_amount AS baseAmount,
      price_numerator AS priceNumerator, price_denominator AS priceDenominator,
      base_is_seller AS baseIsSeller, trade_type AS tradeType,
      validation_status AS validationStatus
    FROM market_trades
    ORDER BY pair_id, received_at_ms, received_sequence, trade_id
  `).all() as TradeRow[];
  const gaps = database.prepare(`
    SELECT pair_id AS pairId, detected_at_ms AS detectedAtMs,
      resolved_at_ms AS resolvedAtMs, status
    FROM market_data_gaps
    ORDER BY pair_id, detected_at_ms, gap_id
  `).all() as GapRow[];

  const fingerprint = hash(JSON.stringify({
    candidates: candidates.map((row) => [
      row.decisionId, row.sourceOrderId, row.placementAtMs, row.limitPrice,
      row.expiresAtMs, row.requestedBase, row.snapshotId, row.cursor,
      row.strategyId, row.feeEstimateJson, row.decisionStatus, row.initialQueue,
      row.initialQueueLower, row.initialQueueUpper,
    ]),
    snapshots: snapshots.map((row) => [
      row.id, row.receivedAtMs, row.receivedSequence, row.integrityStatus, row.contentHash,
    ]),
    trades: trades.map((row) => [
      row.tradeId, row.cursor, row.occurredAtMs, row.receivedAtMs,
      row.baseAmount, row.priceNumerator, row.priceDenominator,
      row.baseIsSeller, row.tradeType, row.validationStatus,
    ]),
    gaps,
  }));
  return { candidates, snapshots, trades, gaps, fingerprint };
}

function eventsForScenario(
  candidate: CandidateRow,
  snapshots: SnapshotRow[],
  trades: TradeRow[],
  expiresAtMs: number,
): ReplayEvent[] {
  const events: ReplayEvent[] = [];
  const firstSnapshot = firstIndexAfter(snapshots, candidate.placementAtMs, (row) => row.receivedAtMs);
  for (let index = firstSnapshot; index < snapshots.length; index += 1) {
    const snapshot = snapshots[index];
    if (!snapshot || snapshot.receivedAtMs > expiresAtMs) {
      break;
    }
    if (snapshot.id !== candidate.snapshotId) {
      events.push({
        observedAtMs: snapshot.receivedAtMs,
        kind: "snapshot",
        key: `${snapshot.receivedSequence ?? 0}:${snapshot.id}`,
        snapshot,
      });
    }
  }
  const firstTrade = firstIndexAfter(trades, candidate.placementAtMs, (row) => row.receivedAtMs);
  for (let index = firstTrade; index < trades.length; index += 1) {
    const trade = trades[index];
    if (!trade || trade.receivedAtMs > expiresAtMs) {
      break;
    }
    events.push({
      observedAtMs: trade.receivedAtMs,
      kind: "trade",
      key: trade.cursor,
      trade,
    });
  }
  events.sort((left, right) => {
    const timeOrder = left.observedAtMs - right.observedAtMs;
    if (timeOrder !== 0) {
      return timeOrder;
    }
    if (left.kind !== right.kind) {
      return left.kind === "snapshot" ? -1 : 1;
    }
    if (left.kind === "trade" && right.kind === "trade") {
      const cursorOrder = compareCursor(left.key, right.key);
      if (cursorOrder !== null) {
        return cursorOrder;
      }
      const leftSequence = left.trade?.receivedSequence;
      const rightSequence = right.trade?.receivedSequence;
      if (leftSequence !== null && leftSequence !== undefined
        && rightSequence !== null && rightSequence !== undefined
        && leftSequence !== rightSequence) {
        return leftSequence - rightSequence;
      }
      return 0;
    } else if (left.kind === "snapshot" && right.kind === "snapshot") {
      const leftSequence = left.snapshot?.receivedSequence;
      const rightSequence = right.snapshot?.receivedSequence;
      if (leftSequence !== null && leftSequence !== undefined
        && rightSequence !== null && rightSequence !== undefined
        && leftSequence !== rightSequence) {
        return leftSequence - rightSequence;
      }
      return (left.snapshot?.id ?? 0) - (right.snapshot?.id ?? 0);
    }
    return 0;
  });
  return events;
}

function gapReasonsForScenario(
  candidate: CandidateRow,
  expiresAtMs: number,
  gaps: GapRow[],
): string[] {
  return gaps
    .filter((gap) =>
      gap.pairId === candidate.pairId
      && gap.detectedAtMs <= expiresAtMs
      && (gap.resolvedAtMs === null || gap.resolvedAtMs >= candidate.placementAtMs),
    )
    .map((gap) => gap.status === "resolved"
      ? "resolved_trade_data_gap_during_scenario"
      : "unresolved_trade_data_gap_during_scenario");
}

function calculateMarkouts(input: {
  candidate: CandidateRow;
  fill: FillEvent;
  snapshots: SnapshotRow[];
  maxSampleDelayMs: number;
  latestObservedAtMs: number;
}): MarkoutResult[] {
  const fillBase = input.fill.lower;
  if (!fillBase.gt(0)) {
    return [];
  }
  const referenceIndex = firstIndexAfter(
    input.snapshots,
    input.fill.trade.occurredAtMs,
    (snapshot) => snapshot.receivedAtMs,
  ) - 1;
  const fillReferenceSnapshot = input.snapshots[referenceIndex] ?? null;
  const fillReferenceAtMs = fillReferenceSnapshot?.receivedAtMs ?? null;
  const fillReferenceDeviationMs = fillReferenceAtMs === null
    ? null
    : input.fill.trade.occurredAtMs - fillReferenceAtMs;
  let midpoint: Big | null = null;
  if (fillReferenceSnapshot?.integrityStatus === "valid") {
    const fillReferenceBook = parseBook(fillReferenceSnapshot.snapshotJson);
    midpoint = fillReferenceBook.bestBid !== null && fillReferenceBook.bestAsk !== null
      ? new Big(fillReferenceBook.bestBid).plus(fillReferenceBook.bestAsk).div(2)
      : null;
  }
  let referenceUnavailableReason: string | null = null;
  if (!fillReferenceSnapshot) {
    referenceUnavailableReason = "no_pre_fill_reference_snapshot";
  } else if (fillReferenceSnapshot.integrityStatus !== "valid") {
    referenceUnavailableReason = "fill_reference_snapshot_integrity_rejected";
  } else if (
    fillReferenceDeviationMs !== null
    && fillReferenceDeviationMs > MAX_ORDER_BOOK_SNAPSHOT_GAP_MS
  ) {
    referenceUnavailableReason = "pre_fill_reference_snapshot_too_old";
  } else if (midpoint === null) {
    referenceUnavailableReason = "fill_reference_snapshot_requires_two_sided_book";
  }
  const results: MarkoutResult[] = [];
  for (const horizonSeconds of REPLAY_MARKOUT_HORIZONS_SECONDS) {
    const targetAtMs = input.fill.trade.occurredAtMs + horizonSeconds * 1000;
    if (referenceUnavailableReason !== null || midpoint === null) {
      results.push({
        fill: input.fill,
        horizonSeconds,
        fillReferenceSnapshot,
        fillReferenceAtMs,
        fillReferenceDeviationMs,
        targetAtMs,
        sampledSnapshot: null,
        sampledAtMs: null,
        deviationMs: null,
        status: "incomplete",
        spreadCaptureQuote: null,
        priceMovementQuote: null,
        liquidationImpactQuote: null,
        feesQuote: null,
        netQuote: null,
        reasons: [referenceUnavailableReason ?? "fill_reference_price_unavailable"],
      });
      continue;
    }
    const firstEligibleIndex = firstIndexAtOrAfter(
      input.snapshots,
      targetAtMs,
      (snapshot) => snapshot.receivedAtMs,
    );
    const possibleSample = input.snapshots[firstEligibleIndex];
    if (possibleSample && possibleSample.receivedAtMs > targetAtMs + input.maxSampleDelayMs) {
      results.push({
        fill: input.fill,
        horizonSeconds,
        fillReferenceSnapshot,
        fillReferenceAtMs,
        fillReferenceDeviationMs,
        targetAtMs,
        sampledSnapshot: possibleSample,
        sampledAtMs: possibleSample.receivedAtMs,
        deviationMs: possibleSample.receivedAtMs - targetAtMs,
        status: "invalid",
        spreadCaptureQuote: null,
        priceMovementQuote: null,
        liquidationImpactQuote: null,
        feesQuote: null,
        netQuote: null,
        reasons: ["markout_sample_exceeds_sampling_tolerance"],
      });
      continue;
    }
    const sampled = possibleSample ?? null;
    if (!sampled) {
      const status = input.latestObservedAtMs >= targetAtMs + input.maxSampleDelayMs
        ? "incomplete"
        : "pending";
      results.push({
        fill: input.fill,
        horizonSeconds,
        fillReferenceSnapshot,
        fillReferenceAtMs,
        fillReferenceDeviationMs,
        targetAtMs,
        sampledSnapshot: null,
        sampledAtMs: null,
        deviationMs: null,
        status,
        spreadCaptureQuote: null,
        priceMovementQuote: null,
        liquidationImpactQuote: null,
        feesQuote: null,
        netQuote: null,
        reasons: [status === "pending"
          ? "markout_horizon_not_yet_observed"
          : "no_snapshot_within_sampling_tolerance"],
      });
      continue;
    }
    const sampledAtMs = sampled.receivedAtMs;
    const deviationMs = sampledAtMs - targetAtMs;
    if (sampled.integrityStatus !== "valid") {
      results.push({
        fill: input.fill,
        horizonSeconds,
        fillReferenceSnapshot,
        fillReferenceAtMs,
        fillReferenceDeviationMs,
        targetAtMs,
        sampledSnapshot: sampled,
        sampledAtMs,
        deviationMs,
        status: "invalid",
        spreadCaptureQuote: null,
        priceMovementQuote: null,
        liquidationImpactQuote: null,
        feesQuote: null,
        netQuote: null,
        reasons: ["sampled_snapshot_integrity_rejected"],
      });
      continue;
    }
    const book = parseBook(sampled.snapshotJson);
    if (midpoint === null || book.bestBid === null || book.bestAsk === null) {
      results.push({
        fill: input.fill,
        horizonSeconds,
        fillReferenceSnapshot,
        fillReferenceAtMs,
        fillReferenceDeviationMs,
        targetAtMs,
        sampledSnapshot: sampled,
        sampledAtMs,
        deviationMs,
        status: "invalid",
        spreadCaptureQuote: null,
        priceMovementQuote: null,
        liquidationImpactQuote: null,
        feesQuote: null,
        netQuote: null,
        reasons: ["markout_requires_two_sided_books"],
      });
      continue;
    }
    const sampleMidpoint = new Big(book.bestBid).plus(book.bestAsk).div(2);
    const spreadCapture = input.candidate.side === "buy"
      ? midpoint.minus(input.candidate.limitPrice).times(fillBase)
      : new Big(input.candidate.limitPrice).minus(midpoint).times(fillBase);
    const priceMovement = input.candidate.side === "buy"
      ? sampleMidpoint.minus(midpoint).times(fillBase)
      : midpoint.minus(sampleMidpoint).times(fillBase);
    const liquidation = estimateExecutableVolume(
      book,
      input.candidate.side === "buy" ? "sell" : "buy",
      fillBase.toString(),
    );
    if (!liquidation.complete) {
      results.push({
        fill: input.fill,
        horizonSeconds,
        fillReferenceSnapshot,
        fillReferenceAtMs,
        fillReferenceDeviationMs,
        targetAtMs,
        sampledSnapshot: sampled,
        sampledAtMs,
        deviationMs,
        status: "incomplete",
        spreadCaptureQuote: spreadCapture.toString(),
        priceMovementQuote: priceMovement.toString(),
        liquidationImpactQuote: null,
        feesQuote: null,
        netQuote: null,
        reasons: ["insufficient_executable_liquidation_depth"],
      });
      continue;
    }
    const midValue = sampleMidpoint.times(fillBase);
    const liquidationQuote = new Big(liquidation.quoteAmount);
    const liquidationImpact = input.candidate.side === "buy"
      ? liquidationQuote.minus(midValue)
      : midValue.minus(liquidationQuote);
    const totalFee = feeEstimateForFill(
      input.candidate.feeEstimateJson,
      fillBase,
      new Big(input.candidate.requestedBase),
    );
    if (totalFee === null) {
      results.push({
        fill: input.fill,
        horizonSeconds,
        fillReferenceSnapshot,
        fillReferenceAtMs,
        fillReferenceDeviationMs,
        targetAtMs,
        sampledSnapshot: sampled,
        sampledAtMs,
        deviationMs,
        status: "incomplete",
        spreadCaptureQuote: spreadCapture.toString(),
        priceMovementQuote: priceMovement.toString(),
        liquidationImpactQuote: liquidationImpact.toString(),
        feesQuote: null,
        netQuote: null,
        reasons: ["simulated_fee_estimate_unavailable"],
      });
      continue;
    }
    const net = spreadCapture.plus(priceMovement).plus(liquidationImpact).minus(totalFee);
    results.push({
      fill: input.fill,
      horizonSeconds,
      fillReferenceSnapshot,
      fillReferenceAtMs,
      fillReferenceDeviationMs,
      targetAtMs,
      sampledSnapshot: sampled,
      sampledAtMs,
      deviationMs,
      status: "complete",
      spreadCaptureQuote: spreadCapture.toString(),
      priceMovementQuote: priceMovement.toString(),
      liquidationImpactQuote: liquidationImpact.toString(),
      feesQuote: totalFee.toString(),
      netQuote: net.toString(),
      reasons: [],
    });
  }
  return results;
}

function feeEstimateForFill(feeJson: string, fill: Big, requested: Big): Big | null {
  try {
    const fee: unknown = JSON.parse(feeJson);
    if (
      typeof fee !== "object"
      || fee === null
      || !("networkFeeQuote" in fee)
      || typeof fee.networkFeeQuote !== "string"
      || !new Big(fee.networkFeeQuote).gt(0)
    ) {
      return null;
    }
    return new Big(fee.networkFeeQuote).times(fill).div(requested);
  } catch {
    return null;
  }
}

function replayScenario(input: {
  runId: string;
  candidate: CandidateRow;
  snapshots: SnapshotRow[];
  trades: TradeRow[];
  gaps: GapRow[];
  maxSampleDelayMs: number;
  latestObservedAtMs: number;
}): ScenarioResult {
  const { candidate } = input;
  const scenarioId = hash(`${input.runId}:${candidate.decisionId}`);
  const expiresAtMs = candidate.expiresAtMs;
  const reasons = new Set<string>();
  const events: FillEvent[] = [];
  let fillLower = new Big(0);
  let fillUpper = new Big(0);
  let firstFillAtMs: number | null = null;
  let initialBook: OrderBookSnapshot | null = null;
  try {
    initialBook = parseBook(candidate.snapshotJson);
  } catch {
    reasons.add("placement_snapshot_malformed");
  }
  if (candidate.snapshotIntegrity !== "valid") {
    reasons.add("placement_snapshot_integrity_rejected");
  }
  if (candidate.snapshotReceivedAtMs >= candidate.placementAtMs) {
    reasons.add(candidate.snapshotReceivedAtMs === candidate.placementAtMs
      ? "placement_snapshot_event_order_ambiguous"
      : "placement_precedes_its_source_snapshot");
  }
  const initialQueues = initialBook
    ? queueAtPrice(initialBook, candidate.side, candidate.limitPrice)
    : { better: new Big(0), same: new Big(0) };
  let queueLower = new Big(candidate.initialQueueLower);
  let queueUpper = new Big(candidate.initialQueueUpper);
  const visibleInitialQueue = initialQueues.better.plus(initialQueues.same);
  if (queueUpper.lt(queueLower) || queueLower.lt(visibleInitialQueue)) {
    reasons.add("initial_queue_bounds_conflict_with_visible_book");
  }
  const hiddenQueueAllowance = queueUpper.minus(visibleInitialQueue).gt(0)
    ? queueUpper.minus(visibleInitialQueue)
    : new Big(0);
  let previousQueues = initialQueues;
  if (candidate.cursor === null) {
    reasons.add("trade_cursor_unavailable_at_placement");
  }
  const gapReasons = gapReasonsForScenario(candidate, expiresAtMs, input.gaps);
  gapReasons.forEach((reason) => reasons.add(reason));

  const timeline = eventsForScenario(candidate, input.snapshots, input.trades, expiresAtMs);
  let priorSnapshotAtMs = candidate.snapshotReceivedAtMs;
  let priorSnapshotSequence: number | null = null;
  let priorTradeSequence: number | null = null;
  let priorTradeEventAtMs: number | null = null;
  for (let index = 0; index < timeline.length; index += 1) {
    const event = timeline[index];
    if (!event) {
      continue;
    }
    const previous = timeline[index - 1];
    const next = timeline[index + 1];
    if (
      (previous?.observedAtMs === event.observedAtMs && previous.kind !== event.kind)
      || (next?.observedAtMs === event.observedAtMs && next.kind !== event.kind)
    ) {
      reasons.add("cross_stream_event_order_ambiguous");
      continue;
    }
    if (event.kind === "snapshot" && event.snapshot) {
      if (
        event.snapshot.receivedSequence !== null
        && priorSnapshotSequence !== null
        && event.snapshot.receivedSequence <= priorSnapshotSequence
      ) {
        reasons.add("snapshot_receive_sequence_out_of_order");
        continue;
      }
      if (event.snapshot.receivedSequence !== null) {
        priorSnapshotSequence = event.snapshot.receivedSequence;
      }
      if (event.snapshot.receivedAtMs - priorSnapshotAtMs > MAX_ORDER_BOOK_SNAPSHOT_GAP_MS) {
        reasons.add("order_book_snapshot_gap_during_scenario");
      }
      priorSnapshotAtMs = event.snapshot.receivedAtMs;
      if (event.snapshot.integrityStatus !== "valid") {
        reasons.add("invalid_order_book_snapshot_during_scenario");
        continue;
      }
      let nextBook: OrderBookSnapshot;
      try {
        nextBook = parseBook(event.snapshot.snapshotJson);
      } catch {
        reasons.add("malformed_order_book_snapshot_during_scenario");
        continue;
      }
      const queues = queueAtPrice(nextBook, candidate.side, candidate.limitPrice);
      if (queues.same.gt(previousQueues.same)) {
        reasons.add("new_same_price_liquidity_ordering_uncertain");
      }
      if (!queues.better.eq(previousQueues.better) || !queues.same.eq(previousQueues.same)) {
        reasons.add("queue_change_between_snapshots_is_attribution_ambiguous");
        queueLower = maxBig(
          queueLower,
          queues.better.plus(minBig(previousQueues.same, queues.same)),
        );
        queueUpper = maxBig(
          queueUpper,
          queues.better.plus(queues.same).plus(hiddenQueueAllowance),
        );
      }
      previousQueues = queues;
      continue;
    }
    const trade = event.trade;
    if (!trade || trade.tradeType !== "orderbook") {
      continue;
    }
    if (trade.validationStatus !== "valid") {
      reasons.add("unvalidated_orderbook_trade_during_scenario");
      continue;
    }
    const matchingSide = candidate.side === "buy"
      ? trade.baseIsSeller === 1
      : trade.baseIsSeller === 0;
    if (!matchingSide) {
      continue;
    }
    const price = new Big(trade.priceNumerator).div(trade.priceDenominator);
    const limit = new Big(candidate.limitPrice);
    const exact = price.eq(limit);
    const through = candidate.side === "buy" ? price.lt(limit) : price.gt(limit);
    if (!exact && !through) {
      continue;
    }
    if (candidate.cursor !== null && candidate.cursor !== "now") {
      const cursorOrder = compareCursor(trade.cursor, candidate.cursor);
      if (cursorOrder === null) {
        reasons.add("trade_cursor_ordering_ambiguous");
        continue;
      }
      if (cursorOrder <= 0) {
        continue;
      }
    }
    if (
      !Number.isSafeInteger(trade.occurredAtMs)
      || trade.occurredAtMs <= 0
      || !Number.isSafeInteger(trade.receivedAtMs)
      || trade.receivedAtMs <= 0
    ) {
      reasons.add("invalid_trade_timestamp");
      continue;
    }
    if (trade.occurredAtMs > trade.receivedAtMs || trade.occurredAtMs > expiresAtMs) {
      reasons.add("trade_timestamp_out_of_range");
      continue;
    }
    if (
      trade.receivedSequence !== null
      && priorTradeSequence !== null
      && trade.receivedSequence <= priorTradeSequence
    ) {
      reasons.add("trade_receive_sequence_out_of_order");
      continue;
    }
    if (trade.receivedSequence !== null) {
      priorTradeSequence = trade.receivedSequence;
    }
    if (priorTradeEventAtMs !== null && trade.occurredAtMs < priorTradeEventAtMs) {
      reasons.add("trade_event_time_out_of_order");
      continue;
    }
    priorTradeEventAtMs = trade.occurredAtMs;
    if (trade.occurredAtMs < candidate.placementAtMs - TRADE_EVENT_TIME_SAFETY_MS) {
      continue;
    }
    if (Math.abs(trade.occurredAtMs - candidate.placementAtMs) <= TRADE_EVENT_TIME_SAFETY_MS) {
      reasons.add("ledger_close_time_precision_makes_ordering_ambiguous");
      continue;
    }

    const volume = new Big(trade.baseAmount);
    const lowerBefore = queueLower;
    const upperBefore = queueUpper;
    const lowerThisTrade = volume.minus(upperBefore).gt(0)
      ? volume.minus(upperBefore)
      : new Big(0);
    const upperThisTrade = volume.minus(lowerBefore).gt(0)
      ? volume.minus(lowerBefore)
      : new Big(0);
    const remainingLower = new Big(candidate.requestedBase).minus(fillLower);
    const remainingUpper = new Big(candidate.requestedBase).minus(fillUpper);
    const boundedLower = through ? new Big(0) : minBig(lowerThisTrade, remainingLower);
    const boundedUpper = minBig(upperThisTrade, remainingUpper);
    const tradeReasons = through ? ["price_through_fill_is_counterfactual"] : [];
    if (through) {
      reasons.add("price_through_fill_is_counterfactual");
    }
    if (!boundedUpper.gt(0)) {
      tradeReasons.push("trade_volume_did_not_exhaust_queue");
    }
    const classification = !boundedUpper.gt(0)
      ? "no_fill_evidence"
      : through || !boundedLower.eq(boundedUpper)
        ? "uncertain_fill"
        : "modeled_fill_estimate";
    events.push({
      trade,
      lower: boundedLower,
      upper: boundedUpper,
      queueLowerBefore: lowerBefore,
      queueUpperBefore: upperBefore,
      classification,
      reasons: tradeReasons,
    });
    fillLower = fillLower.plus(boundedLower);
    fillUpper = fillUpper.plus(boundedUpper);
    if (boundedLower.gt(0) && firstFillAtMs === null) {
      firstFillAtMs = trade.occurredAtMs;
    }
    if (!through) {
      queueLower = queueLower.minus(volume).gt(0) ? queueLower.minus(volume) : new Big(0);
      queueUpper = queueUpper.minus(volume).gt(0) ? queueUpper.minus(volume) : new Big(0);
      const consumedVisibleSame = minBig(previousQueues.same, volume);
      previousQueues = {
        better: previousQueues.better,
        same: previousQueues.same.minus(consumedVisibleSame),
      };
    }
  }

  const coverageComplete = input.latestObservedAtMs >= expiresAtMs;
  if (expiresAtMs - priorSnapshotAtMs > MAX_ORDER_BOOK_SNAPSHOT_GAP_MS) {
    reasons.add("order_book_snapshot_gap_during_scenario");
  }
  if (!coverageComplete) {
    reasons.add("scenario_observation_window_not_fully_covered");
  }
  const hasDataGap = gapReasons.length > 0
    || reasons.has("order_book_snapshot_gap_during_scenario")
    || reasons.has("invalid_trade_timestamp")
    || reasons.has("trade_timestamp_out_of_range")
    || reasons.has("unvalidated_orderbook_trade_during_scenario")
    || reasons.has("initial_queue_bounds_conflict_with_visible_book")
    || reasons.has("invalid_order_book_snapshot_during_scenario")
    || reasons.has("malformed_order_book_snapshot_during_scenario");
  const hasAmbiguity = [...reasons].some((reason) =>
    reason.includes("ambiguous")
    || reason.includes("uncertain")
    || reason.includes("out_of_order")
    || reason === "price_through_fill_is_counterfactual"
    || reason === "trade_cursor_ordering_ambiguous",
  );
  let status: ScenarioResult["status"];
  let evidenceQuality: ScenarioResult["evidenceQuality"];
  let confidence: ScenarioResult["confidence"];
  if (
    !coverageComplete
    || hasDataGap
    || reasons.has("placement_snapshot_integrity_rejected")
    || reasons.has("placement_snapshot_malformed")
    || candidate.cursor === null
    || reasons.has("placement_precedes_its_source_snapshot")
  ) {
    status = "incomplete";
    evidenceQuality = "incomplete";
    confidence = "none";
  } else if (hasAmbiguity || reasons.has("invalid_order_book_snapshot_during_scenario")) {
    status = "uncertain";
    evidenceQuality = "uncertain";
    confidence = "low";
  } else if (!fillUpper.gt(0)) {
    status = "no_fill_evidence";
    evidenceQuality = "sufficient";
    confidence = "medium";
  } else if (!fillLower.eq(fillUpper)) {
    status = "uncertain";
    evidenceQuality = "uncertain";
    confidence = "low";
  } else {
    status = fillLower.gte(candidate.requestedBase) ? "modeled_fill" : "partial_fill";
    evidenceQuality = "sufficient";
    confidence = "low";
  }

  const markouts = events
    .filter((event) =>
      evidenceQuality === "sufficient"
      && event.lower.gt(0)
      && event.classification === "modeled_fill_estimate",
    )
    .flatMap((fill) => calculateMarkouts({
      candidate,
      fill,
      snapshots: input.snapshots,
      maxSampleDelayMs: input.maxSampleDelayMs,
      latestObservedAtMs: input.latestObservedAtMs,
    }));

  return {
    scenarioId,
    candidate,
    status,
    fillLower,
    fillUpper,
    remainingLower: new Big(candidate.requestedBase).minus(fillUpper),
    remainingUpper: new Big(candidate.requestedBase).minus(fillLower),
    firstFillAtMs,
    evidenceQuality,
    confidence,
    reasons: [...reasons],
    events,
    markouts,
  };
}

function persistScenario(database: Database.Database, runId: string, result: ScenarioResult, nowMs: number): void {
  database.transaction(() => {
    const inserted = database.prepare(`
      INSERT OR IGNORE INTO research_execution_scenarios (
        scenario_id, replay_run_id, source_decision_id, source_hypothetical_order_id,
        pair_id, side, limit_price, requested_base, placement_at_ms,
        placement_snapshot_id, initial_visible_queue_base, initial_queue_lower_base,
        initial_queue_upper_base, starting_trade_cursor,
        expires_at_ms, model_version, execution_mode, status,
        estimated_fill_lower_base, estimated_fill_upper_base,
        remaining_lower_base, remaining_upper_base, first_fill_at_ms,
        evidence_quality, confidence, quality_reasons_json, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      result.scenarioId,
      runId,
      result.candidate.decisionId,
      result.candidate.sourceOrderId,
      result.candidate.pairId,
      result.candidate.side,
      result.candidate.limitPrice,
      result.candidate.requestedBase,
      result.candidate.placementAtMs,
      result.candidate.snapshotId,
      result.candidate.initialQueue,
      result.candidate.initialQueueLower,
      result.candidate.initialQueueUpper,
      result.candidate.cursor,
      result.candidate.expiresAtMs,
      HISTORICAL_REPLAY_MODEL_VERSION,
      REPLAY_EXECUTION_MODE,
      result.status,
      result.fillLower.toString(),
      result.fillUpper.toString(),
      result.remainingLower.toString(),
      result.remainingUpper.toString(),
      result.firstFillAtMs,
      result.evidenceQuality,
      result.confidence,
      JSON.stringify(result.reasons),
      nowMs,
    );
    if (inserted.changes === 0) {
      return;
    }
    const insertEvent = database.prepare(`
      INSERT OR IGNORE INTO research_execution_events (
        scenario_id, trade_id, event_at_ms, trade_price, modeled_fill_price,
        public_trade_volume_base,
        queue_ahead_lower_before_base, queue_ahead_upper_before_base,
        modeled_fill_lower_base, modeled_fill_upper_base,
        fill_classification, quality_reasons_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const fill of result.events) {
      insertEvent.run(
        result.scenarioId,
        fill.trade.tradeId,
        fill.trade.occurredAtMs,
        new Big(fill.trade.priceNumerator).div(fill.trade.priceDenominator).toString(),
        fill.upper.gt(0) ? result.candidate.limitPrice : null,
        fill.trade.baseAmount,
        fill.queueLowerBefore.toString(),
        fill.queueUpperBefore.toString(),
        fill.lower.toString(),
        fill.upper.toString(),
        fill.classification,
        JSON.stringify(fill.reasons),
      );
    }
    const insertMarkout = database.prepare(`
      INSERT OR IGNORE INTO research_markout_observations (
        scenario_id, fill_trade_id, horizon_seconds, target_at_ms,
        sampled_snapshot_id, sampled_at_ms, sampling_deviation_ms, status,
        fill_base, fill_price, spread_capture_quote,
        post_fill_price_movement_quote, liquidation_impact_quote,
        estimated_fees_quote, net_markout_quote, quality_reasons_json,
        fill_reference_snapshot_id, fill_reference_at_ms,
        fill_reference_deviation_ms, fill_reference_time_basis
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const markout of result.markouts) {
      insertMarkout.run(
        result.scenarioId,
        markout.fill.trade.tradeId,
        markout.horizonSeconds,
        markout.targetAtMs,
        markout.sampledSnapshot?.id ?? null,
        markout.sampledAtMs,
        markout.deviationMs,
        markout.status,
        markout.fill.lower.toString(),
        result.candidate.limitPrice,
        markout.spreadCaptureQuote,
        markout.priceMovementQuote,
        markout.liquidationImpactQuote,
        markout.feesQuote,
        markout.netQuote,
        JSON.stringify(markout.reasons),
        markout.fillReferenceSnapshot?.id ?? null,
        markout.fillReferenceAtMs,
        markout.fillReferenceDeviationMs,
        markout.fillReferenceSnapshot ? "snapshot_receive_time_vs_ledger_close_time" : null,
      );
    }
  })();
}

function summarize(database: Database.Database, runId: string): HistoricalReplaySummary {
  const counts = database.prepare(`
    SELECT status, COUNT(*) AS count
    FROM research_execution_scenarios WHERE replay_run_id = ?
    GROUP BY status
  `).all(runId) as { status: ScenarioResult["status"]; count: number }[];
  const scenarioStatuses: HistoricalReplaySummary["scenarioStatuses"] = {
    modeled_fill: 0,
    partial_fill: 0,
    no_fill_evidence: 0,
    uncertain: 0,
    incomplete: 0,
  };
  for (const row of counts) {
    scenarioStatuses[row.status] = row.count;
  }
  const evidence = database.prepare(`
    SELECT evidence_quality AS quality, COUNT(*) AS count
    FROM research_execution_scenarios WHERE replay_run_id = ?
    GROUP BY evidence_quality
  `).all(runId) as { quality: ScenarioResult["evidenceQuality"]; count: number }[];
  const evidenceQuality: HistoricalReplaySummary["evidenceQuality"] = {
    sufficient: 0,
    uncertain: 0,
    incomplete: 0,
  };
  for (const row of evidence) {
    evidenceQuality[row.quality] = row.count;
  }
  const qualityReasonCounts = database.prepare(`
    SELECT j.value AS reason, COUNT(*) AS count
    FROM research_execution_scenarios s, json_each(s.quality_reasons_json) j
    WHERE s.replay_run_id = ?
    GROUP BY j.value
    ORDER BY count DESC, j.value
    LIMIT 50
  `).all(runId) as Array<{ reason: string; count: number }>;
  const eventEvidenceRows = database.prepare(`
    SELECT e.fill_classification AS classification,
      e.modeled_fill_lower_base AS fillLower,
      e.modeled_fill_upper_base AS fillUpper
    FROM research_execution_events e
    JOIN research_execution_scenarios s USING (scenario_id)
    WHERE s.replay_run_id = ?
  `).all(runId) as Array<{
    classification: FillEvent["classification"];
    fillLower: string;
    fillUpper: string;
  }>;
  const scenarioFillRows = database.prepare(`
    SELECT requested_base AS requested,
      estimated_fill_lower_base AS fillLower,
      estimated_fill_upper_base AS fillUpper
    FROM research_execution_scenarios
    WHERE replay_run_id = ?
  `).all(runId) as Array<{
    requested: string;
    fillLower: string;
    fillUpper: string;
  }>;
  const fillEvidence: HistoricalReplaySummary["fillEvidence"] = {
    modeledFillEvents: eventEvidenceRows.filter((row) =>
      new Big(row.fillLower).gt(0)
      && row.classification === "modeled_fill_estimate",
    ).length,
    uncertainFillEvents: eventEvidenceRows.filter((row) =>
      new Big(row.fillUpper).gt(0)
      && row.classification === "uncertain_fill",
    ).length,
    scenariosWithLowerBoundFill: scenarioFillRows.filter((row) =>
      new Big(row.fillLower).gt(0),
    ).length,
    scenariosWithPossibleFill: scenarioFillRows.filter((row) =>
      new Big(row.fillUpper).gt(0),
    ).length,
    scenariosWithPartialLowerBoundFill: scenarioFillRows.filter((row) =>
      new Big(row.fillLower).gt(0)
      && new Big(row.fillLower).lt(row.requested),
    ).length,
  };
  const markoutRows = database.prepare(`
    SELECT m.horizon_seconds AS horizonSeconds, m.status, COUNT(*) AS count
    FROM research_markout_observations m
    JOIN research_execution_scenarios s USING (scenario_id)
    WHERE s.replay_run_id = ?
    GROUP BY m.horizon_seconds, m.status
  `).all(runId) as Array<{
    horizonSeconds: number;
    status: MarkoutResult["status"];
    count: number;
  }>;
  const markoutsByHorizon = REPLAY_MARKOUT_HORIZONS_SECONDS.map((horizonSeconds) => {
    const horizon = markoutRows.filter((row) => row.horizonSeconds === horizonSeconds);
    return {
      horizonSeconds,
      complete: horizon.find((row) => row.status === "complete")?.count ?? 0,
      pending: horizon.find((row) => row.status === "pending")?.count ?? 0,
      incomplete: horizon.find((row) => row.status === "incomplete")?.count ?? 0,
      invalid: horizon.find((row) => row.status === "invalid")?.count ?? 0,
    };
  });
  const run = database.prepare(`
    SELECT model_version AS modelVersion, execution_mode AS executionMode
    FROM historical_replay_runs WHERE replay_run_id = ?
  `).get(runId) as { modelVersion: string; executionMode: typeof REPLAY_EXECUTION_MODE };
  return {
    replayRunId: runId,
    modelVersion: run.modelVersion,
    executionMode: run.executionMode,
    scenarioCount: Object.values(scenarioStatuses).reduce((sum, count) => sum + count, 0),
    completeObservationWindowCount:
      scenarioStatuses.modeled_fill
      + scenarioStatuses.partial_fill
      + scenarioStatuses.no_fill_evidence
      + scenarioStatuses.uncertain,
    scenarioStatuses,
    evidenceQuality,
    qualityReasonCounts,
    fillEvidence,
    modeledFillCount: scenarioStatuses.modeled_fill,
    partialFillCount: scenarioStatuses.partial_fill,
    markoutsByHorizon,
    portfolioSimulationImplemented: false,
    independentExperimentsMustNotBeSummedAsPortfolioPnl: true,
  };
}

export class HistoricalReplayEngine {
  constructor(
    private readonly database: Database.Database,
    private readonly options: {
      maxMarkoutSampleDelayMs?: number;
      nowMs?: number;
    } = {},
  ) {}

  run(): HistoricalReplaySummary {
    const nowMs = this.options.nowMs ?? Date.now();
    const maxSampleDelayMs = this.options.maxMarkoutSampleDelayMs ?? 30_000;
    if (!Number.isSafeInteger(maxSampleDelayMs) || maxSampleDelayMs < 0) {
      throw new Error("Maximum markout sampling delay must be a nonnegative integer");
    }
    const inputs = this.database.transaction(() => loadInputs(this.database)).deferred();
    const runFingerprint = hash(`${inputs.fingerprint}:markout_delay:${maxSampleDelayMs}`);
    const runId = hash(
      `${HISTORICAL_REPLAY_MODEL_VERSION}:${REPLAY_EXECUTION_MODE}:${runFingerprint}`,
    );
    this.database.prepare(`
      INSERT OR IGNORE INTO historical_replay_runs (
        replay_run_id, input_fingerprint, model_version, execution_mode,
        created_at_ms, status, scenario_count, quality_summary_json
      ) VALUES (?, ?, ?, ?, ?, 'running', 0, '{}')
    `).run(
      runId,
      runFingerprint,
      HISTORICAL_REPLAY_MODEL_VERSION,
      REPLAY_EXECUTION_MODE,
      nowMs,
    );
    const existing = this.database.prepare(`
      SELECT status FROM historical_replay_runs WHERE replay_run_id = ?
    `).get(runId) as { status: "running" | "complete" | "failed" };
    if (existing.status !== "complete") {
      const pairSnapshots = new Map<string, SnapshotRow[]>();
      const pairTrades = new Map<string, TradeRow[]>();
      for (const row of inputs.snapshots) {
        const values = pairSnapshots.get(row.pairId) ?? [];
        values.push(row);
        pairSnapshots.set(row.pairId, values);
      }
      for (const row of inputs.trades) {
        const values = pairTrades.get(row.pairId) ?? [];
        values.push(row);
        pairTrades.set(row.pairId, values);
      }
      const latestByPair = new Map<string, number>();
      for (const snapshot of inputs.snapshots) {
        latestByPair.set(
          snapshot.pairId,
          Math.max(latestByPair.get(snapshot.pairId) ?? 0, snapshot.receivedAtMs),
        );
      }
      for (const candidate of inputs.candidates) {
        const scenarioId = hash(`${runId}:${candidate.decisionId}`);
        const exists = this.database.prepare(`
          SELECT 1 FROM research_execution_scenarios WHERE scenario_id = ?
        `).get(scenarioId);
        if (exists) {
          continue;
        }
        const result = replayScenario({
          runId,
          candidate,
          snapshots: pairSnapshots.get(candidate.pairId) ?? [],
          trades: pairTrades.get(candidate.pairId) ?? [],
          gaps: inputs.gaps,
          maxSampleDelayMs,
          latestObservedAtMs: latestByPair.get(candidate.pairId) ?? 0,
        });
        persistScenario(this.database, runId, result, nowMs);
      }
      const summary = summarize(this.database, runId);
      this.database.prepare(`
        UPDATE historical_replay_runs
        SET status = 'complete', completed_at_ms = ?, scenario_count = ?,
          quality_summary_json = ?
        WHERE replay_run_id = ? AND status != 'complete'
      `).run(nowMs, summary.scenarioCount, JSON.stringify({
        scenarioStatuses: summary.scenarioStatuses,
        completeObservationWindowCount: summary.completeObservationWindowCount,
        evidenceQuality: summary.evidenceQuality,
        qualityReasonCounts: summary.qualityReasonCounts,
        fillEvidence: summary.fillEvidence,
        markoutsByHorizon: summary.markoutsByHorizon,
      }), runId);
    }
    return summarize(this.database, runId);
  }
}
