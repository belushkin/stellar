import { Big } from "../common/decimal.js";
import type { MakerModelEvidence, PassiveMakerSide } from "./passive-maker.js";

export interface PassiveFillMarkout {
  baseAmount: string;
  limitPrice: string;
  midpointAtFill: string;
  midpointAfterMarkout: string;
  otherModeledCostPerBaseQuote: string;
  opportunityCostPerBaseQuote: string;
}

export interface PassiveOrderOutcome {
  side: PassiveMakerSide;
  requestedBaseAmount: string;
  fills: PassiveFillMarkout[];
}

function nonnegative(value: string, field: string): Big {
  const parsed = new Big(value);
  if (!parsed.gte(0)) {
    throw new Error(`${field} must be nonnegative`);
  }
  return parsed;
}

export function buildMakerModelEvidence(
  outcomes: PassiveOrderOutcome[],
  pairId: string,
  measuredAtMs: number,
): MakerModelEvidence | undefined {
  if (!Number.isFinite(measuredAtMs) || measuredAtMs < 0) {
    throw new Error("Evidence timestamp must be a nonnegative finite number");
  }
  if (pairId.trim().length === 0) {
    throw new Error("Evidence pair ID must not be empty");
  }
  const firstOutcome = outcomes[0];
  if (!firstOutcome) {
    return undefined;
  }
  const side = firstOutcome.side;
  if (outcomes.some((outcome) => outcome.side !== side)) {
    throw new Error("Evidence outcomes must use a single passive side");
  }

  let requestedBase = new Big(0);
  let filledBase = new Big(0);
  let grossPnl = new Big(0);
  let adverseSelectionCost = new Big(0);
  let otherModeledCost = new Big(0);
  let opportunityCost = new Big(0);

  for (const outcome of outcomes) {
    const requested = nonnegative(outcome.requestedBaseAmount, "Requested order amount");
    if (!requested.gt(0)) {
      throw new Error("Requested order amount must be positive");
    }

    requestedBase = requestedBase.plus(requested);
    let orderFilled = new Big(0);
    for (const fill of outcome.fills) {
      const base = nonnegative(fill.baseAmount, "Filled base amount");
      if (!base.gt(0)) {
        throw new Error("Filled base amount must be positive");
      }

      const limit = nonnegative(fill.limitPrice, "Limit price");
      const midpointAtFill = nonnegative(fill.midpointAtFill, "Fill midpoint");
      const midpointAfter = nonnegative(fill.midpointAfterMarkout, "Markout midpoint");
      const otherPerBase = nonnegative(
        fill.otherModeledCostPerBaseQuote,
        "Other modeled cost",
      );
      const opportunityPerBase = nonnegative(
        fill.opportunityCostPerBaseQuote,
        "Opportunity cost",
      );
      const spreadCapturePerBase = outcome.side === "buy"
        ? midpointAtFill.minus(limit)
        : limit.minus(midpointAtFill);
      const markoutPnlPerBase = outcome.side === "buy"
        ? midpointAfter.minus(midpointAtFill)
        : midpointAtFill.minus(midpointAfter);

      orderFilled = orderFilled.plus(base);
      filledBase = filledBase.plus(base);
      grossPnl = grossPnl.plus(base.times(spreadCapturePerBase));
      adverseSelectionCost = adverseSelectionCost.plus(
        base.times(markoutPnlPerBase.lt(0) ? markoutPnlPerBase.abs() : 0),
      );
      otherModeledCost = otherModeledCost.plus(base.times(otherPerBase));
      opportunityCost = opportunityCost.plus(base.times(opportunityPerBase));
    }

    if (orderFilled.gt(requested)) {
      throw new Error("Observed fills exceed the submitted passive order amount");
    }
  }

  if (!filledBase.gt(0)) {
    return undefined;
  }

  return {
    pairId,
    side,
    measuredAtMs,
    sampleCount: outcomes.length,
    queueModel: "conservative_trade_through",
    expectedFillFraction: filledBase.div(requestedBase).toString(),
    expectedGrossPnlPerFilledBaseQuote: grossPnl.div(filledBase).toString(),
    adverseSelectionCostPerFilledBaseQuote: adverseSelectionCost.div(filledBase).toString(),
    otherModeledCostPerFilledBaseQuote: otherModeledCost.div(filledBase).toString(),
    opportunityCostPerFilledBaseQuote: opportunityCost.div(filledBase).toString(),
  };
}
