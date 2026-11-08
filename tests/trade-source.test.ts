import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  server: {
    trades: vi.fn(),
  },
}));

vi.mock("@stellar/stellar-sdk", () => ({
  Asset: class {
    static native(): object {
      return {};
    }

    constructor(_code: string, _issuer: string) {}
  },
  Horizon: {
    Server: class {
      trades = mocks.server.trades;
    },
  },
}));

import { loadConfig } from "../src/config/schema.js";
import { HorizonTradeSource } from "../src/market-data/trade-source.js";

const pair = {
  base: { type: "native" as const },
  quote: {
    type: "credit" as const,
    code: "USDC",
    issuer: "GA24LJXFG73JGARIBG2GP6V5TNUUOS6BD23KOFCW3INLDY5KPKS7GACZ",
  },
};

function tradeRecord(cursor: string, id: string) {
  return {
    id,
    paging_token: cursor,
    ledger_close_time: "2025-01-01T00:00:00Z",
    base_amount: "1.25",
    base_is_seller: true,
    trade_type: "orderbook",
    price: { n: "2", d: "1" },
    base_offer_id: "41",
    counter_offer_id: "42",
    base_account: "GBASE",
    counter_account: "GCOUNTER",
    base_liquidity_pool_id: "pool-base",
    counter_liquidity_pool_id: "pool-counter",
    _links: {
      operation: { href: "https://horizon.example/operations/op-1" },
      transaction: { href: "https://horizon.example/transactions/tx-1" },
    },
  };
}

describe("HorizonTradeSource", () => {
  beforeEach(() => {
    mocks.server.trades.mockReset();
  });

  it("preserves compound cursors through pagination and retains Horizon metadata", async () => {
    const records = Array.from({ length: 200 }, (_, index) =>
      tradeRecord(`280717078191775745-${index + 1}`, `trade-${index + 1}`),
    );
    const secondPageRecord = tradeRecord(
      "280717086781706241-1",
      "trade-page-2",
    );
    const secondPage = {
      records: [secondPageRecord],
      next: vi.fn(),
    };
    const firstPage = {
      records,
      next: vi.fn().mockResolvedValue(secondPage),
    };
    const builder = {
      forAssetPair: vi.fn().mockReturnThis(),
      cursor: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      call: vi.fn().mockResolvedValue(firstPage),
    };
    mocks.server.trades.mockReturnValue(builder);

    const source = new HorizonTradeSource(loadConfig({ STELLAR_MAX_RETRIES: "0" }));
    const collected: Parameters<Parameters<typeof source.catchUp>[2]>[0][] = [];
    const result = await source.catchUp(pair, "280717078191775745-0", (trade) => {
      collected.push(trade);
    });

    expect(builder.cursor).toHaveBeenCalledWith("280717078191775745-0");
    expect(builder.order).toHaveBeenCalledWith("asc");
    expect(builder.limit).toHaveBeenCalledWith(200);
    expect(firstPage.next).toHaveBeenCalledOnce();
    expect(collected).toHaveLength(201);
    expect(result).toEqual({
      count: 201,
      lastCursor: "280717086781706241-1",
    });
    expect(collected[200]).toMatchObject({
      cursor: "280717086781706241-1",
      ledgerCloseTime: "2025-01-01T00:00:00Z",
      baseOfferId: "41",
      counterOfferId: "42",
      baseAccount: "GBASE",
      counterAccount: "GCOUNTER",
      baseLiquidityPoolId: "pool-base",
      counterLiquidityPoolId: "pool-counter",
      operationId: "op-1",
      transactionHash: "tx-1",
      horizonRawJson: JSON.stringify(secondPageRecord),
    });
  });
});
