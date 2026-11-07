import type { TradingPairConfig } from "../config/schema.js";
import { Big } from "../common/decimal.js";
import type {
  OrderBookDepth,
  OrderBookLevel,
  OrderBookSnapshot,
  RawOrderBook,
  RawOrderBookLevel,
} from "./types.js";

function amount(value: string, field: string): Big {
  let parsed: Big;
  try {
    parsed = new Big(value);
  } catch (error) {
    throw new Error(`Invalid order book ${field}: ${value}`, { cause: error });
  }

  if (!parsed.gt(0)) {
    throw new Error(`Order book ${field} must be positive`);
  }

  return parsed;
}

function price(level: RawOrderBookLevel): Big {
  const { n, d } = level.price_r;
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d) || n <= 0 || d <= 0) {
    throw new Error("Order book price_r must contain positive safe integers");
  }

  return new Big(n.toString()).div(d.toString());
}

function normalizeSide(
  levels: RawOrderBookLevel[],
  order: "ascending" | "descending",
): OrderBookLevel[] {
  const normalized = levels.map((level) => ({
    amount: amount(level.amount, "amount").toString(),
    price: price(level).toString(),
  }));

  normalized.sort((left, right) => {
    const comparison = new Big(left.price).cmp(right.price);
    return order === "ascending" ? comparison : -comparison;
  });

  return normalized;
}

function depth(levels: OrderBookLevel[]): OrderBookDepth {
  let baseAmount = new Big(0);
  let quoteAmount = new Big(0);

  for (const level of levels) {
    const base = new Big(level.amount);
    baseAmount = baseAmount.plus(base);
    quoteAmount = quoteAmount.plus(base.times(level.price));
  }

  return {
    baseAmount: baseAmount.toString(),
    quoteAmount: quoteAmount.toString(),
  };
}

function assetId(asset: TradingPairConfig["base"]): string {
  if (asset.type === "native") {
    return "XLM";
  }
  return `${asset.code}:${asset.issuer}`;
}

export function getPairId(pair: TradingPairConfig): string {
  return `${assetId(pair.base)}/${assetId(pair.quote)}`;
}

export function normalizeOrderBook(
  raw: RawOrderBook,
  pair: TradingPairConfig,
  receivedAtMs: number = Date.now(),
): OrderBookSnapshot {
  const bids = normalizeSide(raw.bids, "descending");
  const asks = normalizeSide(raw.asks, "ascending");
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;

  let spreadAbsolute: string | null = null;
  let spreadPercent: string | null = null;
  if (bestBid !== null && bestAsk !== null) {
    const spread = new Big(bestAsk).minus(bestBid);
    const midpoint = new Big(bestAsk).plus(bestBid).div(2);
    spreadAbsolute = spread.toString();
    spreadPercent = spread.div(midpoint).times(100).toString();
  }

  return {
    pairId: getPairId(pair),
    baseAsset: assetId(pair.base),
    quoteAsset: assetId(pair.quote),
    bids,
    asks,
    receivedAt: new Date(receivedAtMs).toISOString(),
    receivedAtMs,
    latestLedger: null,
    bestBid,
    bestAsk,
    spreadAbsolute,
    spreadPercent,
    bidDepth: depth(bids),
    askDepth: depth(asks),
  };
}
