export interface RawOrderBookLevel {
  amount: string;
  price_r: {
    d: number;
    n: number;
  };
}

export interface RawOrderBook {
  bids: RawOrderBookLevel[];
  asks: RawOrderBookLevel[];
}

export interface OrderBookLevel {
  amount: string;
  price: string;
}

export interface OrderBookDepth {
  baseAmount: string;
  quoteAmount: string;
}

export interface OrderBookSnapshot {
  pairId: string;
  baseAsset: string;
  quoteAsset: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  receivedAt: string;
  receivedAtMs: number;
  latestLedger: null;
  bestBid: string | null;
  bestAsk: string | null;
  spreadAbsolute: string | null;
  spreadPercent: string | null;
  bidDepth: OrderBookDepth;
  askDepth: OrderBookDepth;
}

export type ExecutionSide = "buy" | "sell";

export interface ExecutableVolumeEstimate {
  side: ExecutionSide;
  requestedBaseAmount: string;
  filledBaseAmount: string;
  remainingBaseAmount: string;
  quoteAmount: string;
  averagePrice: string | null;
  slippagePercent: string | null;
  complete: boolean;
}
