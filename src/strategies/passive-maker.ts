import { Big } from "../common/decimal.js";
import type { AppConfig, TradingPairConfig } from "../config/schema.js";
import { getPairId } from "../order-book/normalize.js";
import { estimateExecutableVolume } from "../order-book/executable-volume.js";
import type { OrderBookSnapshot } from "../order-book/types.js";
import {
  roundTripOperationCount,
  type NetworkFeeEstimate,
} from "../market-data/fee-estimator.js";

export type PassiveMakerSide = "buy" | "sell";
export type PassiveMakerSignalStatus =
  | "positive"
  | "rejected"
  | "insufficient_data";

export interface MakerModelEvidence {
  pairId: string;
  side: PassiveMakerSide;
  measuredAtMs: number;
  sampleCount: number;
  queueModel: "conservative_trade_through";
  expectedFillFraction: string;
  expectedGrossPnlPerFilledBaseQuote: string;
  adverseSelectionCostPerFilledBaseQuote: string;
  otherModeledCostPerFilledBaseQuote: string;
  opportunityCostPerFilledBaseQuote: string;
}

export interface MakerPortfolioState {
  pairId: string;
  baseInventory: string;
  availableBase: string;
  availableQuote: string;
}

export interface PassiveMakerSignal {
  pairId: string;
  side: PassiveMakerSide;
  status: PassiveMakerSignalStatus;
  reasons: string[];
  limitPrice: string | null;
  requestedBaseAmount: string;
  queueAheadBase: string | null;
  expectedFilledBase: string | null;
  expectedGrossPnlQuote: string | null;
  networkFeeNature: "simulated_estimate";
  networkFeeXlm: string | null;
  networkFeeQuote: string | null;
  adverseSelectionCostQuote: string | null;
  inventoryRiskCostQuote: string | null;
  otherModeledCostsQuote: string | null;
  opportunityCostQuote: string | null;
  expectedNetProfitQuote: string | null;
  feeOperationCount: number;
  feeRateMethod: NetworkFeeEstimate["feeRateMethod"];
  feeStatsLastLedger: string | null;
  feeStatsFetchedAtMs: number | null;
  feeConversionPath: string[] | null;
  feeConversionFetchedAtMs: number | null;
  feeEstimateReason: string | null;
  displayedSpreadPercent: string | null;
}

function sumAtPrice(
  levels: OrderBookSnapshot["bids"],
  price: string,
): Big {
  return levels.reduce(
    (total, level) => total.plus(
      new Big(level.price).eq(price) ? level.amount : "0",
    ),
    new Big(0),
  );
}

function inventoryRiskCost(
  inventory: Big,
  expectedFilledBase: Big,
  midPrice: Big,
  side: PassiveMakerSide,
  riskBps: number,
): Big {
  const before = inventory.abs().times(midPrice);
  const afterInventory = side === "buy"
    ? inventory.plus(expectedFilledBase)
    : inventory.minus(expectedFilledBase);
  const after = afterInventory.abs().times(midPrice);
  const increasedExposure = after.gt(before) ? after.minus(before) : new Big(0);
  return increasedExposure.times(riskBps).div(10_000);
}

function parseDecimal(value: string): Big | undefined {
  try {
    return new Big(value);
  } catch {
    return undefined;
  }
}

function validNonNegativeDecimal(value: string): Big | undefined {
  const parsed = parseDecimal(value);
  return parsed?.gte(0) ? parsed : undefined;
}

export function evaluatePassiveMakerSignal(input: {
  book: OrderBookSnapshot;
  pair: TradingPairConfig;
  side: PassiveMakerSide;
  portfolio: MakerPortfolioState | undefined;
  evidence: MakerModelEvidence | undefined;
  fees: NetworkFeeEstimate;
  assetIdentityValid?: boolean;
  orderFlowAvailable?: boolean;
  config: Pick<
    AppConfig,
    | "maxOrderBookAgeMs"
    | "minimumSpreadPercent"
    | "minimumLiquidityBase"
    | "maximumSlippagePercent"
    | "minimumExpectedNetProfitQuote"
    | "maximumMakerOrderBase"
    | "maximumInventoryBase"
    | "makerInventoryRiskBps"
    | "makerMinimumEvidenceSamples"
    | "makerEvidenceMaxAgeMs"
    | "makerReplacementsPerOrder"
  >;
  nowMs?: number;
}): PassiveMakerSignal {
  const {
    book,
    side,
    portfolio,
    evidence,
    fees,
    config,
  } = input;
  const nowMs = input.nowMs ?? Date.now();
  const orderSize = new Big(config.maximumMakerOrderBase);
  const limitPrice = side === "buy" ? book.bestBid : book.bestAsk;
  const queueLevels = side === "buy" ? book.bids : book.asks;
  const queueAhead = limitPrice === null ? null : sumAtPrice(queueLevels, limitPrice);
  const reasons = new Set<string>();
  const incompleteReasons = new Set<string>();

  if (book.pairId !== getPairId(input.pair)) {
    reasons.add("order_book_pair_mismatch");
    incompleteReasons.add("order_book_pair_mismatch");
  }
  const expectedOperations = roundTripOperationCount(config.makerReplacementsPerOrder);
  if (
    fees.quoteAssetId !== assetId(input.pair.quote)
    || fees.operationCount !== expectedOperations
  ) {
    reasons.add("network_fee_assumptions_mismatch");
    incompleteReasons.add("network_fee_assumptions_mismatch");
  }
  if (portfolio && portfolio.pairId !== book.pairId) {
    reasons.add("portfolio_pair_mismatch");
    incompleteReasons.add("portfolio_pair_mismatch");
  }
  if (input.assetIdentityValid === false) {
    reasons.add("asset_identity_unverified_or_stale");
    incompleteReasons.add("asset_identity_unverified_or_stale");
  }
  if (input.orderFlowAvailable === false) {
    reasons.add("trade_stream_unavailable");
    incompleteReasons.add("trade_stream_unavailable");
  }

  if (!bookIsFresh(book.receivedAtMs, nowMs, config.maxOrderBookAgeMs)) {
    reasons.add("order_book_stale");
    incompleteReasons.add("order_book_stale");
  }
  if (book.bestBid === null || book.bestAsk === null || book.spreadPercent === null) {
    reasons.add("two_sided_order_book_unavailable");
    incompleteReasons.add("two_sided_order_book_unavailable");
  } else if (new Big(book.bestBid).gte(book.bestAsk)) {
    reasons.add("order_book_crossed_or_locked");
    incompleteReasons.add("order_book_crossed_or_locked");
  } else if (new Big(book.spreadPercent).lt(config.minimumSpreadPercent)) {
    reasons.add("spread_below_minimum");
  }

  const minimumDepth = new Big(book.bidDepth.baseAmount).lt(book.askDepth.baseAmount)
    ? book.bidDepth.baseAmount
    : book.askDepth.baseAmount;
  if (new Big(minimumDepth).lt(config.minimumLiquidityBase)) {
    reasons.add("liquidity_below_minimum");
  }

  if (limitPrice === null || queueAhead === null) {
    reasons.add("maker_limit_unavailable");
    incompleteReasons.add("maker_limit_unavailable");
  }
  const exitEstimate = estimateExecutableVolume(
    book,
    side === "buy" ? "sell" : "buy",
    orderSize.toString(),
  );
  if (!exitEstimate.complete) {
    reasons.add("inventory_exit_depth_insufficient");
    incompleteReasons.add("inventory_exit_depth_insufficient");
  }
  if (exitEstimate.slippagePercent === null) {
    reasons.add("inventory_exit_slippage_unavailable");
    incompleteReasons.add("inventory_exit_slippage_unavailable");
  } else if (new Big(exitEstimate.slippagePercent).gt(config.maximumSlippagePercent)) {
    reasons.add("inventory_exit_slippage_above_limit");
  }

  if (!portfolio) {
    reasons.add("portfolio_unavailable");
    incompleteReasons.add("portfolio_unavailable");
  } else {
    const baseInventory = validNonNegativeDecimal(portfolio.baseInventory);
    const availableBase = validNonNegativeDecimal(portfolio.availableBase);
    const availableQuote = validNonNegativeDecimal(portfolio.availableQuote);
    if (!baseInventory || !availableBase || !availableQuote) {
      reasons.add("portfolio_data_invalid");
      incompleteReasons.add("portfolio_data_invalid");
    } else if (side === "buy") {
      if (limitPrice !== null && availableQuote.lt(orderSize.times(limitPrice))) {
        reasons.add("insufficient_quote_balance");
      }
      if (baseInventory.plus(orderSize).gt(config.maximumInventoryBase)) {
        reasons.add("maximum_inventory_exceeded");
      }
    } else {
      if (availableBase.lt(orderSize) || baseInventory.lt(orderSize)) {
        reasons.add("insufficient_base_inventory");
      }
    }
  }

  let expectedFilledBase: Big | null = null;
  let grossPnl: Big | null = null;
  let adverseSelectionCost: Big | null = null;
  let otherCosts: Big | null = null;
  let opportunityCost: Big | null = null;
  let inventoryCost: Big | null = null;

  if (!evidence) {
    reasons.add("passive_fill_and_markout_evidence_unavailable");
    incompleteReasons.add("passive_fill_and_markout_evidence_unavailable");
  } else {
    if (
      !Number.isInteger(evidence.sampleCount)
      || evidence.sampleCount < config.makerMinimumEvidenceSamples
    ) {
      reasons.add("insufficient_passive_model_samples");
      incompleteReasons.add("insufficient_passive_model_samples");
    }
    if (
      evidence.pairId !== book.pairId
      || evidence.side !== side
      || evidence.queueModel !== "conservative_trade_through"
      || !Number.isFinite(evidence.measuredAtMs)
      || nowMs - evidence.measuredAtMs < 0
      || nowMs - evidence.measuredAtMs > config.makerEvidenceMaxAgeMs
    ) {
      reasons.add("passive_model_evidence_stale_or_incompatible");
      incompleteReasons.add("passive_model_evidence_stale_or_incompatible");
    }

    const fillFraction = validNonNegativeDecimal(evidence.expectedFillFraction);
    const grossPerBase = parseDecimal(evidence.expectedGrossPnlPerFilledBaseQuote);
    const adversePerBase = validNonNegativeDecimal(evidence.adverseSelectionCostPerFilledBaseQuote);
    const otherPerBase = validNonNegativeDecimal(evidence.otherModeledCostPerFilledBaseQuote);
    const opportunityPerBase = validNonNegativeDecimal(evidence.opportunityCostPerFilledBaseQuote);
    if (
      !fillFraction
      || fillFraction.gt(1)
      || !grossPerBase
      || !adversePerBase
      || !otherPerBase
      || !opportunityPerBase
    ) {
      reasons.add("passive_model_values_invalid");
      incompleteReasons.add("passive_model_values_invalid");
    } else {
      expectedFilledBase = orderSize.times(fillFraction);
      grossPnl = expectedFilledBase.times(grossPerBase);
      adverseSelectionCost = expectedFilledBase.times(adversePerBase);
      otherCosts = expectedFilledBase.times(otherPerBase);
      opportunityCost = expectedFilledBase.times(opportunityPerBase);

      if (portfolio && book.bestBid !== null && book.bestAsk !== null) {
        const baseInventory = validNonNegativeDecimal(portfolio.baseInventory);
        if (baseInventory) {
          const midpoint = new Big(book.bestBid).plus(book.bestAsk).div(2);
          inventoryCost = inventoryRiskCost(
            baseInventory,
            expectedFilledBase,
            midpoint,
            side,
            config.makerInventoryRiskBps,
          );
        }
      }
    }
  }

  if (!fees.complete || fees.networkFeeQuote === null) {
    reasons.add("network_fee_conversion_incomplete");
    incompleteReasons.add("network_fee_conversion_incomplete");
  }

  let expectedNetProfit: Big | null = null;
  if (
    grossPnl !== null
    && adverseSelectionCost !== null
    && otherCosts !== null
    && opportunityCost !== null
    && inventoryCost !== null
    && fees.networkFeeQuote !== null
    && fees.complete
    && incompleteReasons.size === 0
  ) {
    expectedNetProfit = grossPnl
      .minus(fees.networkFeeQuote)
      .minus(adverseSelectionCost)
      .minus(inventoryCost)
      .minus(otherCosts)
      .minus(opportunityCost);
    if (expectedNetProfit.lt(config.minimumExpectedNetProfitQuote)) {
      reasons.add("expected_net_profit_below_minimum");
    }
  }

  const reasonList = [...reasons];
  const status: PassiveMakerSignalStatus = reasonList.length === 0
    ? "positive"
    : reasonList.some((reason) => incompleteReasons.has(reason))
      ? "insufficient_data"
      : "rejected";

  return {
    pairId: book.pairId,
    side,
    status,
    reasons: reasonList,
    limitPrice,
    requestedBaseAmount: orderSize.toString(),
    queueAheadBase: queueAhead?.toString() ?? null,
    expectedFilledBase: expectedFilledBase?.toString() ?? null,
    expectedGrossPnlQuote: grossPnl?.toString() ?? null,
    networkFeeNature: fees.nature,
    networkFeeXlm: fees.networkFeeXlm,
    networkFeeQuote: fees.networkFeeQuote,
    adverseSelectionCostQuote: adverseSelectionCost?.toString() ?? null,
    inventoryRiskCostQuote: inventoryCost?.toString() ?? null,
    otherModeledCostsQuote: otherCosts?.toString() ?? null,
    opportunityCostQuote: opportunityCost?.toString() ?? null,
    expectedNetProfitQuote: expectedNetProfit?.toString() ?? null,
    feeOperationCount: fees.operationCount,
    feeRateMethod: fees.feeRateMethod,
    feeStatsLastLedger: fees.feeStatsLastLedger,
    feeStatsFetchedAtMs: fees.feeStatsFetchedAtMs,
    feeConversionPath: fees.conversionPath,
    feeConversionFetchedAtMs: fees.conversionFetchedAtMs,
    feeEstimateReason: fees.reason,
    displayedSpreadPercent: book.spreadPercent,
  };
}

function assetId(asset: TradingPairConfig["quote"]): string {
  return asset.type === "native" ? "native" : `${asset.code}:${asset.issuer}`;
}

function bookIsFresh(receivedAtMs: number, nowMs: number, maxAgeMs: number): boolean {
  const age = nowMs - receivedAtMs;
  return age >= 0 && age <= maxAgeMs;
}
