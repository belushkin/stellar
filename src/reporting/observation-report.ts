import type Database from "better-sqlite3";

import { Big } from "../common/decimal.js";

interface DecisionRow {
  pairId: string;
  strategyId: string;
  status: "positive" | "rejected" | "insufficient_data";
  reasonsJson: string;
}

interface ExecutionRow {
  pairId: string;
  strategyId: string;
  requestedBase: string;
  lowerFill: string;
  upperFill: string;
  lowerFillProbability: string | null;
  upperFillProbability: string | null;
  lowerPartialProbability: string | null;
  upperPartialProbability: string | null;
  observedTradeCount: number;
  orderStatus: "observing" | "complete" | "incomplete" | "rejected";
}

interface MarkoutRow {
  pairId: string;
  strategyId: string;
  horizonMinutes: number;
  gross: string | null;
  net: string | null;
  status: "pending" | "complete" | "incomplete" | "invalid";
}

export interface ObservationReport {
  generatedAtMs: number;
  observationMode: true;
  signals: {
    generated: number;
    byStatus: Record<"positive" | "rejected" | "insufficient_data", number>;
    rejectionReasons: Array<{ reason: string; count: number }>;
  };
  executionEvidence: {
    scenarios: number;
    observedScenarios: number;
    estimatedFillRateBounds: { lower: string | null; upper: string | null };
    estimatedFillProbabilityBounds: { lower: string | null; upper: string | null };
    partialFillRateBounds: { lower: string | null; upper: string | null };
    observedTradeVolumeIsNotProofOfOurExecution: true;
  };
  markoutDistributions: Array<{
    pairId: string;
    strategyId: string;
    horizonMinutes: number;
    sampleSize: number;
    incompleteCount: number;
    grossMeanQuote: string | null;
    netMeanQuote: string | null;
    netMedianQuote: string | null;
    netP05Quote: string | null;
    netP95Quote: string | null;
  }>;
  performanceByPairAndStrategy: Array<{
    pairId: string;
    strategyId: string;
    scenarioCount: number;
    estimatedLowerFillBase: string;
    estimatedUpperFillBase: string;
    completedMarkouts: number;
    grossMarkoutPnlQuote: string;
    netMarkoutPnlQuote: string | null;
  }>;
  portfolioRisk: Array<{
    pairId: string;
    quoteAssetId: string;
    valuationStatus: "complete" | "incomplete" | "invalid";
    dailyNetPnlQuote: string | null;
    maximumDrawdownQuote: string | null;
    inventoryExposureQuote: string | null;
    qualityReasons: string[];
  }>;
}

function average(values: Big[]): string | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((total, value) => total.plus(value), new Big(0))
    .div(values.length)
    .toString();
}

function percentile(values: Big[], fraction: number): string | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left.cmp(right));
  const index = Math.floor((sorted.length - 1) * fraction);
  return sorted[index]?.toString() ?? null;
}

function pairStrategyKey(pairId: string, strategyId: string): string {
  return `${pairId}\u0000${strategyId}`;
}

export function buildObservationReport(input: {
  database: Database.Database;
  portfolioId: string;
  nowMs?: number;
}): ObservationReport {
  const nowMs = input.nowMs ?? Date.now();
  const decisionRows = input.database.prepare(`
    SELECT pair_id AS pairId, strategy_id AS strategyId, status,
      reasons_json AS reasonsJson
    FROM strategy_decisions
    ORDER BY created_at_ms, decision_id
  `).all() as DecisionRow[];
  const byStatus: ObservationReport["signals"]["byStatus"] = {
    positive: 0,
    rejected: 0,
    insufficient_data: 0,
  };
  const reasons = new Map<string, number>();
  for (const decision of decisionRows) {
    byStatus[decision.status] += 1;
    if (decision.status === "positive") {
      continue;
    }
    const parsed: unknown = JSON.parse(decision.reasonsJson);
    if (!Array.isArray(parsed) || parsed.some((reason) => typeof reason !== "string")) {
      throw new Error("Persisted strategy decision reasons are malformed");
    }
    for (const reason of parsed) {
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
  }
  const executions = input.database.prepare(`
    SELECT h.pair_id AS pairId, h.strategy_id AS strategyId,
      h.requested_base AS requestedBase,
      e.estimated_fill_lower_base AS lowerFill,
      e.estimated_fill_upper_base AS upperFill,
      e.estimated_fill_probability_lower AS lowerFillProbability,
      e.estimated_fill_probability_upper AS upperFillProbability,
      e.partial_fill_probability_lower AS lowerPartialProbability,
      e.partial_fill_probability_upper AS upperPartialProbability,
      e.observed_trade_count AS observedTradeCount,
      h.status AS orderStatus
    FROM hypothetical_orders h
    JOIN execution_evidence e USING (hypothetical_order_id)
    WHERE h.status != 'rejected'
  `).all() as ExecutionRow[];
  const fillRateLower: Big[] = [];
  const fillRateUpper: Big[] = [];
  const fillProbabilityLower: Big[] = [];
  const fillProbabilityUpper: Big[] = [];
  const partialProbabilityLower: Big[] = [];
  const partialProbabilityUpper: Big[] = [];
  let observedScenarios = 0;
  for (const execution of executions) {
    if (execution.observedTradeCount === 0 && execution.orderStatus !== "complete") {
      continue;
    }
    observedScenarios += 1;
    const requested = new Big(execution.requestedBase);
    fillRateLower.push(new Big(execution.lowerFill).div(requested));
    fillRateUpper.push(new Big(execution.upperFill).div(requested));
    if (execution.lowerFillProbability !== null) {
      fillProbabilityLower.push(new Big(execution.lowerFillProbability));
    }
    if (execution.upperFillProbability !== null) {
      fillProbabilityUpper.push(new Big(execution.upperFillProbability));
    }
    if (execution.lowerPartialProbability !== null) {
      partialProbabilityLower.push(new Big(execution.lowerPartialProbability));
    }
    if (execution.upperPartialProbability !== null) {
      partialProbabilityUpper.push(new Big(execution.upperPartialProbability));
    }
  }
  const markouts = input.database.prepare(`
    SELECT h.pair_id AS pairId, h.strategy_id AS strategyId,
      m.horizon_minutes AS horizonMinutes, m.markout_gross_quote AS gross,
      m.markout_net_quote AS net, m.status
    FROM markout_observations m
    JOIN hypothetical_orders h USING (hypothetical_order_id)
    ORDER BY h.pair_id, h.strategy_id, m.horizon_minutes, m.target_at_ms
  `).all() as MarkoutRow[];
  const markoutGroups = new Map<string, MarkoutRow[]>();
  for (const markout of markouts) {
    const key = `${pairStrategyKey(markout.pairId, markout.strategyId)}\u0000${markout.horizonMinutes}`;
    const group = markoutGroups.get(key) ?? [];
    group.push(markout);
    markoutGroups.set(key, group);
  }
  const markoutDistributions: ObservationReport["markoutDistributions"] = [];
  for (const group of markoutGroups.values()) {
    const first = group[0];
    if (!first) {
      continue;
    }
    const gross = group.flatMap((item) => item.gross === null ? [] : [new Big(item.gross)]);
    const net = group.flatMap((item) => item.net === null ? [] : [new Big(item.net)]);
    markoutDistributions.push({
      pairId: first.pairId,
      strategyId: first.strategyId,
      horizonMinutes: first.horizonMinutes,
      sampleSize: net.length,
      incompleteCount: group.filter((item) => item.status !== "complete").length,
      grossMeanQuote: average(gross),
      netMeanQuote: average(net),
      netMedianQuote: percentile(net, 0.5),
      netP05Quote: percentile(net, 0.05),
      netP95Quote: percentile(net, 0.95),
    });
  }

  const performanceKeys = new Set<string>();
  for (const row of executions) {
    performanceKeys.add(pairStrategyKey(row.pairId, row.strategyId));
  }
  for (const row of markouts) {
    performanceKeys.add(pairStrategyKey(row.pairId, row.strategyId));
  }
  const performanceByPairAndStrategy = [...performanceKeys].map((key) => {
    const [pairId, strategyId] = key.split("\u0000") as [string, string];
    const matchingExecutions = executions.filter(
      (row) => row.pairId === pairId && row.strategyId === strategyId,
    );
    const matchingMarkouts = markouts.filter(
      (row) => row.pairId === pairId && row.strategyId === strategyId,
    );
    const completed = matchingMarkouts.filter((row) => row.status === "complete");
    const gross = completed.reduce(
      (total, row) => total.plus(row.gross ?? "0"),
      new Big(0),
    );
    const hasMissingNet = completed.some((row) => row.net === null);
    const net = completed.reduce(
      (total, row) => total.plus(row.net ?? "0"),
      new Big(0),
    );
    return {
      pairId,
      strategyId,
      scenarioCount: matchingExecutions.length,
      estimatedLowerFillBase: matchingExecutions.reduce(
        (total, row) => total.plus(row.lowerFill),
        new Big(0),
      ).toString(),
      estimatedUpperFillBase: matchingExecutions.reduce(
        (total, row) => total.plus(row.upperFill),
        new Big(0),
      ).toString(),
      completedMarkouts: completed.length,
      grossMarkoutPnlQuote: gross.toString(),
      netMarkoutPnlQuote: hasMissingNet ? null : net.toString(),
    };
  });
  const valuations = input.database.prepare(`
    SELECT pair_id AS pairId, quote_asset_id AS quoteAssetId,
      valuation_status AS valuationStatus,
      daily_net_pnl_quote AS dailyNetPnlQuote,
      maximum_drawdown_quote AS maximumDrawdownQuote,
      inventory_exposure_quote AS inventoryExposureQuote,
      quality_reasons_json AS qualityReasonsJson
    FROM portfolio_valuation_snapshots
    WHERE portfolio_id = ? AND observed_at_ms = (
      SELECT MAX(observed_at_ms) FROM portfolio_valuation_snapshots latest
      WHERE latest.portfolio_id = portfolio_valuation_snapshots.portfolio_id
        AND latest.pair_id = portfolio_valuation_snapshots.pair_id
    )
    ORDER BY pair_id
  `).all(input.portfolioId) as Array<{
    pairId: string;
    quoteAssetId: string;
    valuationStatus: "complete" | "incomplete" | "invalid";
    dailyNetPnlQuote: string | null;
    maximumDrawdownQuote: string | null;
    inventoryExposureQuote: string | null;
    qualityReasonsJson: string;
  }>;

  return {
    generatedAtMs: nowMs,
    observationMode: true,
    signals: {
      generated: decisionRows.length,
      byStatus,
      rejectionReasons: [...reasons]
        .map(([reason, count]) => ({ reason, count }))
        .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason)),
    },
    executionEvidence: {
      scenarios: executions.length,
      observedScenarios,
      estimatedFillRateBounds: {
        lower: average(fillRateLower),
        upper: average(fillRateUpper),
      },
      estimatedFillProbabilityBounds: {
        lower: average(fillProbabilityLower),
        upper: average(fillProbabilityUpper),
      },
      partialFillRateBounds: {
        lower: average(partialProbabilityLower),
        upper: average(partialProbabilityUpper),
      },
      observedTradeVolumeIsNotProofOfOurExecution: true,
    },
    markoutDistributions,
    performanceByPairAndStrategy,
    portfolioRisk: valuations.map((row) => {
      const qualityReasons: unknown = JSON.parse(row.qualityReasonsJson);
      if (!Array.isArray(qualityReasons) || qualityReasons.some((reason) => typeof reason !== "string")) {
        throw new Error("Persisted portfolio valuation reasons are malformed");
      }
      return {
        pairId: row.pairId,
        quoteAssetId: row.quoteAssetId,
        valuationStatus: row.valuationStatus,
        dailyNetPnlQuote: row.dailyNetPnlQuote,
        maximumDrawdownQuote: row.maximumDrawdownQuote,
        inventoryExposureQuote: row.inventoryExposureQuote,
        qualityReasons,
      };
    }),
  };
}
