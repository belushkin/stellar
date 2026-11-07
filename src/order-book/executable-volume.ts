import { Big } from "../common/decimal.js";

import type {
  ExecutableVolumeEstimate,
  ExecutionSide,
  OrderBookLevel,
  OrderBookSnapshot,
} from "./types.js";

export function estimateExecutableVolume(
  book: OrderBookSnapshot,
  side: ExecutionSide,
  requestedBaseAmount: string,
): ExecutableVolumeEstimate {
  let requested: Big;
  try {
    requested = new Big(requestedBaseAmount);
  } catch (error) {
    throw new Error(`Invalid requested base amount: ${requestedBaseAmount}`, { cause: error });
  }

  if (!requested.gt(0)) {
    throw new Error("Requested base amount must be positive");
  }

  const levels: OrderBookLevel[] = side === "buy" ? book.asks : book.bids;
  const referencePrice = side === "buy" ? book.bestAsk : book.bestBid;
  let remaining = requested;
  let filled = new Big(0);
  let quoteAmount = new Big(0);

  for (const level of levels) {
    if (remaining.eq(0)) {
      break;
    }

    const available = new Big(level.amount);
    const fill = available.lt(remaining) ? available : remaining;
    filled = filled.plus(fill);
    quoteAmount = quoteAmount.plus(fill.times(level.price));
    remaining = remaining.minus(fill);
  }

  const averagePrice = filled.gt(0) ? quoteAmount.div(filled) : null;
  let slippagePercent: string | null = null;
  if (referencePrice !== null && averagePrice !== null) {
    const reference = new Big(referencePrice);
    const adverseDifference = side === "buy"
      ? averagePrice.minus(reference)
      : reference.minus(averagePrice);
    slippagePercent = adverseDifference.div(reference).times(100).toString();
  }

  return {
    side,
    requestedBaseAmount: requested.toString(),
    filledBaseAmount: filled.toString(),
    remainingBaseAmount: remaining.toString(),
    quoteAmount: quoteAmount.toString(),
    averagePrice: averagePrice?.toString() ?? null,
    slippagePercent,
    complete: remaining.eq(0),
  };
}
