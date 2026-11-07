import { Asset, Horizon } from "@stellar/stellar-sdk";

import type { AppConfig, TradingPairConfig } from "../config/schema.js";
import { createLogger } from "../common/logger.js";
import { withRetry } from "../common/retry.js";
import { isRetryableHorizonError } from "../stellar/horizon-client.js";
import type { RawOrderBook } from "../order-book/types.js";

export interface OrderBookStreamHandlers {
  onMessage: (book: RawOrderBook) => void;
  onError: (error: unknown) => void;
}

export interface OrderBookSource {
  fetch(pair: TradingPairConfig): Promise<RawOrderBook>;
  stream(pair: TradingPairConfig, handlers: OrderBookStreamHandlers): () => void;
}

function toSdkAsset(asset: TradingPairConfig["base"]): Asset {
  return asset.type === "native"
    ? Asset.native()
    : new Asset(asset.code, asset.issuer);
}

function rawBook(book: { bids: RawOrderBook["bids"]; asks: RawOrderBook["asks"] }): RawOrderBook {
  return { bids: book.bids, asks: book.asks };
}

export class HorizonOrderBookSource implements OrderBookSource {
  private readonly server: InstanceType<typeof Horizon.Server>;
  private readonly logger: ReturnType<typeof createLogger>;

  constructor(private readonly config: AppConfig) {
    this.server = new Horizon.Server(config.horizonUrl);
    this.logger = createLogger(config.logLevel);
  }

  async fetch(pair: TradingPairConfig): Promise<RawOrderBook> {
    const response = await withRetry(
      () => this.server.orderbook(toSdkAsset(pair.base), toSdkAsset(pair.quote)).call(),
      {
        maxRetries: this.config.maxRetries,
        baseDelayMs: this.config.retryBaseDelayMs,
        maxDelayMs: this.config.retryMaxDelayMs,
        onRetry: (error, retryNumber, delayMs) => {
          this.logger.warn(
            { err: error, retryNumber, delayMs, pair },
            "Retrying Horizon order book request",
          );
        },
      },
      isRetryableHorizonError,
    );

    return rawBook(response);
  }

  stream(pair: TradingPairConfig, handlers: OrderBookStreamHandlers): () => void {
    return this.server
      .orderbook(toSdkAsset(pair.base), toSdkAsset(pair.quote))
      .stream({
        onmessage: (book) => handlers.onMessage(rawBook(book)),
        onerror: (event) => handlers.onError(event.data ?? event),
      });
  }
}
