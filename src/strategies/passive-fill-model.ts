import { Big } from "../common/decimal.js";
import type { OrderBookSnapshot } from "../order-book/types.js";
import type { PassiveMakerSide } from "./passive-maker.js";

export interface TradePrint {
  pairId: string;
  baseAmount: string;
  priceNumerator: string;
  priceDenominator: string;
  baseIsSeller: boolean;
  tradeType: string;
  occurredAtMs: number;
}

export interface PassiveFillEstimate {
  limitPrice: string | null;
  queueAheadAtPlacementBase: string | null;
  eligibleTradeVolumeBase: string;
  queueConsumedBase: string;
  filledBase: string;
  remainingBase: string;
  complete: boolean;
}

export function estimateConservativePassiveFill(input: {
  bookAtPlacement: OrderBookSnapshot;
  side: PassiveMakerSide;
  orderBaseAmount: string;
  placedAtMs: number;
  trades: TradePrint[];
}): PassiveFillEstimate {
  const orderSize = new Big(input.orderBaseAmount);
  if (!orderSize.gt(0)) {
    throw new Error("Passive order amount must be positive");
  }

  const limitPrice = input.side === "buy"
    ? input.bookAtPlacement.bestBid
    : input.bookAtPlacement.bestAsk;
  if (limitPrice === null) {
    return {
      limitPrice: null,
      queueAheadAtPlacementBase: null,
      eligibleTradeVolumeBase: "0",
      queueConsumedBase: "0",
      filledBase: "0",
      remainingBase: orderSize.toString(),
      complete: false,
    };
  }

  const levels = input.side === "buy"
    ? input.bookAtPlacement.bids
    : input.bookAtPlacement.asks;
  const initialQueue = levels.reduce(
    (total, level) => (
      input.side === "buy"
        ? new Big(level.price).gte(limitPrice)
        : new Big(level.price).lte(limitPrice)
    )
      ? total.plus(level.amount)
      : total,
    new Big(0),
  );

  const trades = [...input.trades]
    .filter((trade) =>
      trade.pairId === input.bookAtPlacement.pairId
      && trade.occurredAtMs > input.placedAtMs,
    )
    .sort((left, right) => left.occurredAtMs - right.occurredAtMs);
  let eligibleVolume = new Big(0);
  let queueRemaining = initialQueue;
  let queueConsumed = new Big(0);
  let filled = new Big(0);

  for (const trade of trades) {
    if (trade.tradeType !== "orderbook") {
      continue;
    }
    if (trade.baseIsSeller !== (input.side === "buy")) {
      continue;
    }

    const tradePrice = new Big(trade.priceNumerator)
      .div(trade.priceDenominator);
    const priceCrossed = input.side === "buy"
      ? tradePrice.lte(limitPrice)
      : tradePrice.gte(limitPrice);
    if (!priceCrossed) {
      continue;
    }

    const tradeAmount = new Big(trade.baseAmount);
    if (!tradeAmount.gt(0)) {
      throw new Error("Trade base amount must be positive");
    }

    eligibleVolume = eligibleVolume.plus(tradeAmount);
    const amountAgainstQueue = tradeAmount.lt(queueRemaining)
      ? tradeAmount
      : queueRemaining;
    queueRemaining = queueRemaining.minus(amountAgainstQueue);
    queueConsumed = queueConsumed.plus(amountAgainstQueue);

    const volumeAfterQueue = tradeAmount.minus(amountAgainstQueue);
    const availableOrderSize = orderSize.minus(filled);
    const fill = volumeAfterQueue.lt(availableOrderSize)
      ? volumeAfterQueue
      : availableOrderSize;
    filled = filled.plus(fill);
    if (filled.eq(orderSize)) {
      break;
    }
  }

  const remaining = orderSize.minus(filled);
  return {
    limitPrice,
    queueAheadAtPlacementBase: initialQueue.toString(),
    eligibleTradeVolumeBase: eligibleVolume.toString(),
    queueConsumedBase: queueConsumed.toString(),
    filledBase: filled.toString(),
    remainingBase: remaining.toString(),
    complete: remaining.eq(0),
  };
}
