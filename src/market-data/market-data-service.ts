import type { TradingPairConfig } from "../config/schema.js";
import type { OrderBookSnapshot } from "../order-book/types.js";
import { getPairId, normalizeOrderBook } from "../order-book/normalize.js";
import type { OrderBookSource } from "./order-book-source.js";

export interface OrderBookHandlers {
  onUpdate: (book: OrderBookSnapshot) => void;
  onError: (error: unknown) => void;
}

export function isOrderBookFresh(
  book: OrderBookSnapshot,
  maxAgeMs: number,
  nowMs: number = Date.now(),
): boolean {
  const ageMs = nowMs - book.receivedAtMs;
  return ageMs >= 0 && ageMs <= maxAgeMs;
}

export class MarketDataService {
  private readonly streams = new Map<string, () => void>();

  constructor(private readonly source: OrderBookSource) {}

  async start(
    pair: TradingPairConfig,
    handlers: OrderBookHandlers,
  ): Promise<OrderBookSnapshot> {
    const pairId = getPairId(pair);
    if (this.streams.has(pairId)) {
      throw new Error(`Order book stream already active for ${pairId}`);
    }

    const initial = normalizeOrderBook(await this.source.fetch(pair), pair);
    handlers.onUpdate(initial);

    const stop = this.source.stream(pair, {
      onMessage: (book) => {
        try {
          handlers.onUpdate(normalizeOrderBook(book, pair));
        } catch (error) {
          handlers.onError(error);
        }
      },
      onError: handlers.onError,
    });

    this.streams.set(initial.pairId, stop);
    return initial;
  }

  stop(pairId: string): void {
    const stop = this.streams.get(pairId);
    if (stop) {
      stop();
      this.streams.delete(pairId);
    }
  }

  stopAll(): void {
    for (const stop of this.streams.values()) {
      stop();
    }
    this.streams.clear();
  }
}
