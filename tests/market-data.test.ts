import { describe, expect, it, vi } from "vitest";

import type { TradingPairConfig } from "../src/config/schema.js";
import {
  isOrderBookFresh,
  MarketDataService,
} from "../src/market-data/market-data-service.js";
import type {
  OrderBookSource,
  OrderBookStreamHandlers,
} from "../src/market-data/order-book-source.js";
import type { RawOrderBook } from "../src/order-book/types.js";

const pair: TradingPairConfig = {
  base: { type: "native" },
  quote: { type: "credit", code: "USDC", issuer: "GA24LJXFG73JGARIBG2GP6V5TNUUOS6BD23KOFCW3INLDY5KPKS7GACZ" },
};

const book: RawOrderBook = {
  bids: [{ price_r: { n: 99, d: 100 }, amount: "10" }],
  asks: [{ price_r: { n: 101, d: 100 }, amount: "10" }],
};

describe("MarketDataService", () => {
  it("publishes the initial snapshot and subsequent stream updates, and stops cleanly", async () => {
    let streamHandlers: OrderBookStreamHandlers | undefined;
    const stop = vi.fn();
    const source: OrderBookSource = {
      fetch: vi.fn().mockResolvedValue(book),
      stream: vi.fn((_pair, handlers) => {
        streamHandlers = handlers;
        return stop;
      }),
    };
    const service = new MarketDataService(source);
    const onUpdate = vi.fn();

    const initial = await service.start(pair, { onUpdate, onError: vi.fn() });
    expect(initial.bestBid).toBe("0.99");
    expect(onUpdate).toHaveBeenCalledTimes(1);

    streamHandlers?.onMessage({
      bids: [{ price_r: { n: 1, d: 1 }, amount: "5" }],
      asks: [],
    });
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate.mock.calls[1]?.[0].bestBid).toBe("1");

    service.stop(initial.pairId);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("rejects duplicate pair subscriptions without opening another stream", async () => {
    const source: OrderBookSource = {
      fetch: vi.fn().mockResolvedValue(book),
      stream: vi.fn(() => vi.fn()),
    };
    const service = new MarketDataService(source);

    await service.start(pair, { onUpdate: vi.fn(), onError: vi.fn() });
    await expect(service.start(pair, { onUpdate: vi.fn(), onError: vi.fn() }))
      .rejects.toThrow("Order book stream already active");

    expect(source.fetch).toHaveBeenCalledOnce();
    expect(source.stream).toHaveBeenCalledOnce();
    service.stopAll();
  });

  it("routes malformed streamed snapshots to the explicit error handler", async () => {
    let streamHandlers: OrderBookStreamHandlers | undefined;
    const source: OrderBookSource = {
      fetch: vi.fn().mockResolvedValue(book),
      stream: vi.fn((_pair, handlers) => {
        streamHandlers = handlers;
        return vi.fn();
      }),
    };
    const service = new MarketDataService(source);
    const onError = vi.fn();

    await service.start(pair, { onUpdate: vi.fn(), onError });
    streamHandlers?.onMessage({
      bids: [{ price_r: { n: 1, d: 0 }, amount: "5" }],
      asks: [],
    });

    expect(onError).toHaveBeenCalledOnce();
    service.stopAll();
  });
});

describe("isOrderBookFresh", () => {
  it("uses local receive timestamps and rejects future or over-age snapshots", async () => {
    const source: OrderBookSource = {
      fetch: vi.fn().mockResolvedValue(book),
      stream: vi.fn(() => vi.fn()),
    };
    const service = new MarketDataService(source);
    const snapshot = await service.start(pair, { onUpdate: vi.fn(), onError: vi.fn() });

    expect(isOrderBookFresh(snapshot, 100, snapshot.receivedAtMs + 100)).toBe(true);
    expect(isOrderBookFresh(snapshot, 100, snapshot.receivedAtMs + 101)).toBe(false);
    expect(isOrderBookFresh(snapshot, 100, snapshot.receivedAtMs - 1)).toBe(false);
    service.stopAll();
  });
});
