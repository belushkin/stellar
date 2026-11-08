import { describe, expect, it, vi } from "vitest";

import {
  applyOfferEventsToBook,
  estimateCounterfactualBound,
  extractOfferEvents,
  fetchBookSnapshot,
  type BookSnapshot,
  type OfferLifecycleEvent,
  type OfferValue,
  type ResearchPair,
} from "../src/research/offer-ledger-poc.js";

const unit = 10_000_000n;
const pair: ResearchPair = {
  base: { type: "native" },
  quote: {
    type: "credit",
    code: "USDC",
    issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  },
};

function snapshot(askAmount = 100n * unit): BookSnapshot {
  return {
    ledger: 100,
    requestStartedAt: "2025-01-01T00:00:00.000Z",
    capturedAt: "2025-01-01T00:00:00.000Z",
    source: "fixture",
    raw: "{}",
    bids: [{ priceN: 9, priceD: 10, amountStroops: 40n * unit }],
    asks: [{ priceN: 11, priceD: 10, amountStroops: askAmount }],
    truncated: { bids: false, asks: false },
  };
}

function offer(
  amountStroops: bigint,
  priceN = 11,
  priceD = 10,
  offerId = "7",
): OfferValue {
  return {
    seller: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    offerId,
    sellingAsset: "native",
    buyingAsset: `${pair.quote.code}:${pair.quote.issuer}`,
    amountStroops,
    priceN,
    priceD,
  };
}

function event(
  type: OfferLifecycleEvent["type"],
  before: OfferValue | null,
  after: OfferValue | null,
  changeIndex = 0,
  offerKey = `${offer(0n).seller}:${before?.offerId ?? after?.offerId ?? "7"}`,
): OfferLifecycleEvent {
  return {
    ledger: 101,
    transactionIndex: 0,
    operationIndex: 0,
    changeIndex,
    offerKey,
    type,
    before,
    after,
  };
}

describe("offer-ledger proof of concept", () => {
  it("applies a partial offer reduction exactly once", () => {
    const replay = applyOfferEventsToBook(
      snapshot(),
      [event("updated", offer(100n * unit), offer(70n * unit))],
      pair,
    );

    expect(replay.valid).toBe(true);
    expect(replay.levels.asks[0]?.amountStroops).toBe(70n * unit);
  });

  it("replays identical input deterministically", () => {
    const start = snapshot();
    const events = [event("updated", offer(100n * unit), offer(70n * unit))];

    expect(applyOfferEventsToBook(start, events, pair))
      .toEqual(applyOfferEventsToBook(start, events, pair));
  });

  it("applies cancellations as observed book depletion without labeling them trades", () => {
    const replay = applyOfferEventsToBook(
      snapshot(),
      [event("removed", offer(30n * unit), null)],
      pair,
    );

    expect(replay.valid).toBe(true);
    expect(replay.levels.asks[0]?.amountStroops).toBe(70n * unit);
    expect(replay.events[0]?.type).toBe("removed");
  });

  it("moves a modified offer between exact rational price levels", () => {
    const start = snapshot(10n * unit);
    start.asks.push({ priceN: 6, priceD: 5, amountStroops: 4n * unit });
    const replay = applyOfferEventsToBook(
      start,
      [event("updated", offer(10n * unit), offer(7n * unit, 12, 10))],
      pair,
    );

    expect(replay.valid).toBe(true);
    expect(replay.levels.asks).toEqual([
      { priceN: 6, priceD: 5, amountStroops: 11n * unit },
    ]);
  });

  it("adds a newly created offer at the same price level", () => {
    const replay = applyOfferEventsToBook(
      snapshot(),
      [event("created", null, offer(2n * unit))],
      pair,
    );

    expect(replay.levels.asks[0]?.amountStroops).toBe(102n * unit);
  });

  it("tracks newly created liquidity outside a capped start snapshot", () => {
    const start = snapshot();
    start.truncated.asks = true;
    start.asks = Array.from({ length: 200 }, (_, index) => ({
      priceN: 1_000 + index,
      priceD: 1_000,
      amountStroops: unit,
    }));
    const replay = applyOfferEventsToBook(
      start,
      [event("created", null, offer(2n * unit, 3, 1))],
      pair,
    );

    expect(replay.valid).toBe(true);
    expect(replay.levels.asks.at(-1)).toEqual({
      priceN: 3,
      priceD: 1,
      amountStroops: 2n * unit,
    });
  });

  it("reports possible fill only as an upper bound after queue depletion", () => {
    const bound = estimateCounterfactualBound(snapshot(), [
      event("removed", offer(100n * unit), null),
      event("removed", offer(1n * unit, 11, 10, "8"), null, 1, "seller:8"),
    ], pair, "sell");

    expect(bound?.queueAheadBaseStroops).toBe((100n * unit).toString());
    expect(bound?.observedGrossDepletionBaseStroops).toBe((101n * unit).toString());
    expect(bound?.lowerBoundFillBaseStroops).toBe("0");
    expect(bound?.upperBoundFillBaseStroops).toBe(unit.toString());
    expect(bound?.classification).toBe("upper_bound_only");
  });

  it("does not count post-insertion offers as queue depletion", () => {
    const created = offer(5n * unit, 11, 10, "8");
    const bound = estimateCounterfactualBound(snapshot(), [
      event("created", null, created, 0, "seller:8"),
      event("removed", created, null, 1, "seller:8"),
    ], pair, "sell");

    expect(bound?.observedGrossDepletionBaseStroops).toBe("0");
    expect(bound?.upperBoundFillBaseStroops).toBe("0");
  });

  it("fails closed for missing prior state, duplicate changes, and regressed order", () => {
    const missing = applyOfferEventsToBook(
      snapshot(),
      [event("updated", null, offer(1n * unit))],
      pair,
    );
    const duplicate = event("removed", offer(1n * unit), null);
    const duplicateResult = applyOfferEventsToBook(snapshot(), [duplicate, duplicate], pair);
    const regressedResult = applyOfferEventsToBook(snapshot(), [
      { ...event("created", null, offer(unit)), operationIndex: 1 },
      { ...event("created", null, offer(unit), 1), operationIndex: 0 },
    ], pair);

    expect(missing.valid).toBe(false);
    expect(missing.reasons).toContain(
      `missing_prior_offer_state:${offer(1n * unit).seller}:7`,
    );
    expect(duplicateResult.reasons).toContain("duplicate_offer_change:101:0:0:0");
    expect(regressedResult.reasons).toContain("offer_event_order_regressed");
  });

  it("accepts operation-index resets when the next transaction is later", () => {
    const replay = applyOfferEventsToBook(snapshot(), [
      { ...event("created", null, offer(unit)), transactionIndex: 0, operationIndex: 2 },
      { ...event("created", null, offer(unit, 11, 10, "8")), transactionIndex: 1, operationIndex: -1 },
    ], pair);

    expect(replay.reasons).not.toContain("offer_event_order_regressed");
  });

  it("normalizes Horizon bid amounts from quote units into base units", async () => {
    const response = new Response(JSON.stringify({
      bids: [{ price_r: { n: 1, d: 2 }, amount: "10.0000000" }],
      asks: [{ price_r: { n: 1, d: 2 }, amount: "10.0000000" }],
    }), { headers: { "latest-ledger": "100" } });
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    try {
      const book = await fetchBookSnapshot("https://horizon.example", pair);
      expect(book.bids[0]?.amountStroops).toBe(20n * unit);
      expect(book.asks[0]?.amountStroops).toBe(10n * unit);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects missing or malformed ledger metadata rather than treating it as an empty ledger", () => {
    const ledger = {
      sequence: 101,
      hash: "fixture",
      ledgerCloseTime: "2025-01-01T00:00:05.000Z",
      headerXdr: "",
      metadataXdr: "not-valid-xdr",
    };
    expect(() => extractOfferEvents({
      ...ledger,
      metadataXdr: "",
    }, pair)).toThrow();
    expect(() => extractOfferEvents(ledger, pair)).toThrow();
  });
});
