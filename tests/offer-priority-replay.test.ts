import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import {
  classifyLedgerOfferChanges,
} from "../src/research/offer-attribution.js";
import {
  compareOfferPriority,
  insertHypotheticalOffer,
  replayOfferPriority,
  replayOfferPriorityRange,
} from "../src/research/offer-priority-replay.js";
import {
  extractOfferEvents,
  type LedgerRecord,
  type OfferLifecycleEvent,
  type OfferValue,
  type ResearchPair,
} from "../src/research/offer-ledger-poc.js";

interface PriorityFixture {
  records: Array<LedgerRecord & {
    sourceRun: string;
    metadataSha256: string;
  }>;
}

const fixture = JSON.parse(
  gunzipSync(
    readFileSync(new URL("./fixtures/offer-priority-ledgers.json.gz", import.meta.url)),
  ).toString(),
) as PriorityFixture;

const pairs = {
  xlmUsdc: {
    base: { type: "native" },
    quote: {
      type: "credit",
      code: "USDC",
      issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    },
  },
  lilXlm: {
    base: {
      type: "credit",
      code: "LIL",
      issuer: "GBAASUPEINF2XYZC3MZGXKK5ANT32XPA6QH2PMQWUJBQK2I6F6V3DD54",
    },
    quote: { type: "native" },
  },
  aquaUsdc: {
    base: {
      type: "credit",
      code: "AQUA",
      issuer: "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA",
    },
    quote: {
      type: "credit",
      code: "USDC",
      issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    },
  },
} satisfies Record<string, ResearchPair>;

function ledger(sequence: number): LedgerRecord {
  const found = fixture.records.find((record) => record.sequence === sequence);
  if (!found) {
    throw new Error(`Missing real-ledger fixture ${sequence}`);
  }
  return found;
}

function offerAt(
  sequence: number,
  pair: ResearchPair,
  predicate: (event: OfferLifecycleEvent) => boolean,
): OfferLifecycleEvent {
  const found = extractOfferEvents(ledger(sequence), pair).find(predicate);
  if (!found) {
    throw new Error(`No matching offer event at ledger ${sequence}`);
  }
  return found;
}

function rationalPriceEqual(left: OfferValue, right: OfferValue): boolean {
  return BigInt(left.priceN) * BigInt(right.priceD)
    === BigInt(right.priceN) * BigInt(left.priceD);
}

describe("Stellar offer priority research replay", () => {
  it("preserves source checksums for the selected real ledger metadata", () => {
    for (const record of fixture.records) {
      const checksum = createHash("sha256")
        .update(Buffer.from(record.metadataXdr, "base64"))
        .digest("hex");
      expect(checksum).toBe(record.metadataSha256);

      const header = xdr.LedgerHeaderHistoryEntry.fromXDR(record.headerXdr, "base64");
      const metadata = xdr.LedgerCloseMeta.fromXDR(record.metadataXdr, "base64");
      expect(header.header.ledgerSeq).toBe(record.sequence);
      expect(header.header.ledgerVersion).toBe(29);
      expect(metadata.type).toBe("v2");
      if (metadata.type === "v2") {
        expect(metadata.value.ledgerHeader.header.ledgerSeq).toBe(record.sequence);
      }
    }
  }, 20_000);

  it("orders real same-price LIL offers created in successive ledgers by Core priority", () => {
    const replay = replayOfferPriorityRange(
      65_374_574,
      65_374_576,
      [ledger(65_374_575), ledger(65_374_576)],
      pairs.lilXlm,
    );
    const first = offerAt(65_374_575, pairs.lilXlm, (event) =>
      event.type === "created" && event.after?.offerId === "1865203943"
    ).after!;
    const second = offerAt(65_374_576, pairs.lilXlm, (event) =>
      event.type === "created" && event.after?.offerId === "1865203951"
    ).after!;

    expect(replay.valid).toBe(true);
    expect(replay.ledgerRangeComplete).toBe(true);
    expect(rationalPriceEqual(first, second)).toBe(true);
    expect(replay.bids.map((entry) => entry.offerId)).toEqual([
      "1865203943",
      "1865203951",
    ]);
    expect(compareOfferPriority(first, second, pairs.lilXlm)).toBeLessThan(0);
  });

  it("orders same-price offers created in different transactions of one ledger", () => {
    const events = extractOfferEvents(ledger(65_374_634), pairs.aquaUsdc)
      .filter((event) => event.type === "created");
    const earlier = events.find((event) => event.transactionIndex === 141)!.after!;
    const later = events.find((event) => event.transactionIndex === 160)!.after!;

    expect(rationalPriceEqual(earlier, later)).toBe(true);
    expect(BigInt(earlier.offerId)).toBeLessThan(BigInt(later.offerId));
    expect(compareOfferPriority(earlier, later, pairs.aquaUsdc)).toBeLessThan(0);
    expect(replayOfferPriority(events, pairs.aquaUsdc).bids.map((entry) => entry.offerId))
      .toEqual(["1865204325", "1865204327"]);
  });

  it("uses operation order for multiple real offer changes in one transaction", () => {
    const transactionEvents = extractOfferEvents(ledger(65_374_566), pairs.xlmUsdc)
      .filter((event) => event.transactionIndex === 15);
    const replay = replayOfferPriority(transactionEvents, pairs.xlmUsdc);
    const reversed = replayOfferPriority([...transactionEvents].reverse(), pairs.xlmUsdc);

    expect(transactionEvents.map((event) => event.operationIndex)).toEqual([0, 1]);
    expect(replay.valid).toBe(true);
    expect(reversed.reasons).toContain("offer_event_order_regressed");
  });

  it("retains the same-price priority key after a real amount modification", () => {
    const changed = offerAt(65_374_566, pairs.xlmUsdc, (event) =>
      event.type === "updated" && event.after?.offerId === "1865203656"
    );
    const before = changed.before!;
    const after = changed.after!;
    const peer = { ...after, offerId: "1865203657" };
    const replay = replayOfferPriority([changed], pairs.xlmUsdc);

    expect(rationalPriceEqual(before, after)).toBe(true);
    expect(before.amountStroops).toBe(167_239_675n);
    expect(after.amountStroops).toBe(167_239_668n);
    expect(after.offerId).toBe(before.offerId);
    expect(compareOfferPriority(after, peer, pairs.xlmUsdc)).toBeLessThan(0);
    expect(replay.valid).toBe(true);
    expect(replay.asks[0]?.offerId).toBe(after.offerId);
    expect(replay.asks[0]?.amountBaseStroops).toBe(after.amountStroops);
  });

  it("does not reset priority when an offer amount increases", () => {
    const changed = offerAt(65_374_566, pairs.xlmUsdc, (event) =>
      event.type === "updated"
      && event.after?.offerId === "1865183703"
      && event.before !== null
      && event.after.amountStroops > event.before.amountStroops
    );
    const replay = replayOfferPriority([changed], pairs.xlmUsdc);
    const remaining = [...replay.bids, ...replay.asks]
      .find((entry) => entry.offerId === changed.after?.offerId);
    const laterOffer = {
      ...changed.after!,
      offerId: (BigInt(changed.after!.offerId) + 1n).toString(),
    };

    expect(changed.after!.amountStroops).toBeGreaterThan(changed.before!.amountStroops);
    expect(replay.valid).toBe(true);
    expect(compareOfferPriority(changed.after!, laterOffer, pairs.xlmUsdc)).toBeLessThan(0);
    expect(remaining?.amountBaseStroops).toBe(
      (changed.after!.amountStroops * BigInt(changed.after!.priceN))
      / BigInt(changed.after!.priceD),
    );
  });

  it("re-ranks a repriced offer without assigning it a new offer ID", () => {
    const changed = offerAt(65_374_566, pairs.xlmUsdc, (event) =>
      event.type === "updated" && event.after?.offerId === "1865201318"
    );
    const before = changed.before!;
    const after = changed.after!;
    const sameNewPricePeer = { ...after, offerId: "1865201317" };

    expect(rationalPriceEqual(before, after)).toBe(false);
    expect(after.offerId).toBe(before.offerId);
    expect(compareOfferPriority(sameNewPricePeer, after, pairs.xlmUsdc)).toBeLessThan(0);
    expect(replayOfferPriority([changed], pairs.xlmUsdc).valid).toBe(true);
  });

  it("keeps a partially executed offer at the same ID and exact remaining amount", () => {
    const evidence = classifyLedgerOfferChanges(ledger(65_374_567), pairs.xlmUsdc)
      .find((event) => event.cause === "execution" && event.before?.offerId === "1865201144");
    expect(evidence?.executedAmountStroops).toBe("280998");

    const replay = replayOfferPriority([evidence!], pairs.xlmUsdc);
    expect(replay.valid).toBe(true);
    expect(replay.asks[0]?.offerId).toBe("1865201144");
    expect(replay.asks[0]?.amountBaseStroops).toBe(39_999_719_002n);
  });

  it("applies real cancellation and recreation as different offer IDs", () => {
    const cancellation = classifyLedgerOfferChanges(ledger(65_374_566), pairs.lilXlm)
      .find((event) => event.cause === "cancellation" && event.before?.offerId === "1865194551");
    const recreation = offerAt(65_374_575, pairs.lilXlm, (event) =>
      event.type === "created" && event.after?.offerId === "1865203943"
    );
    const oldOffer = cancellation?.before!;
    const newOffer = recreation.after!;

    expect(cancellation?.cause).toBe("cancellation");
    expect(oldOffer.seller).toBe(newOffer.seller);
    expect(rationalPriceEqual(oldOffer, newOffer)).toBe(true);
    expect(BigInt(newOffer.offerId)).toBeGreaterThan(BigInt(oldOffer.offerId));
    const replay = replayOfferPriority([cancellation!, recreation], pairs.lilXlm);
    expect(replay.valid).toBe(true);
    expect(replay.bids.map((entry) => entry.offerId)).toContain("1865203943");
    expect(replay.bids.map((entry) => entry.offerId)).not.toContain("1865194551");
  });

  it("detects an omitted ledger sequence instead of silently replaying across it", () => {
    const replay = replayOfferPriorityRange(
      65_374_574,
      65_374_576,
      [ledger(65_374_575)],
      pairs.lilXlm,
    );

    expect(replay.valid).toBe(false);
    expect(replay.ledgerRangeComplete).toBe(false);
    expect(replay.reasons).toContain("missing_ledger_sequence:65374576");
  });

  it("rejects regressed event ordering and inconsistent before-state transitions", () => {
    const first = offerAt(65_374_575, pairs.lilXlm, (event) =>
      event.type === "created" && event.after?.offerId === "1865203943"
    );
    const second = offerAt(65_374_576, pairs.lilXlm, (event) =>
      event.type === "created" && event.after?.offerId === "1865203951"
    );
    const regressed = replayOfferPriority([
      { ...second, ledger: 65_374_576 },
      { ...first, ledger: 65_374_575 },
    ], pairs.lilXlm);
    const update = offerAt(65_374_566, pairs.xlmUsdc, (event) =>
      event.type === "updated" && event.after?.offerId === "1865203656"
    );
    const inconsistentUpdate: OfferLifecycleEvent = {
      ...update,
      transactionIndex: update.transactionIndex + 1,
      before: {
        ...update.after!,
        amountStroops: update.after!.amountStroops + 1n,
      },
      after: {
        ...update.after!,
        amountStroops: update.after!.amountStroops + 2n,
      },
    };
    const inconsistent = replayOfferPriority([update, inconsistentUpdate], pairs.xlmUsdc);

    expect(regressed.reasons).toContain("offer_event_order_regressed");
    expect(inconsistent.reasons).toContain(
      `offer_before_state_mismatch:${update.offerKey}`,
    );
  });

  it("inserts after a known boundary only when the complete book and transaction position are explicit", () => {
    const boundary = ledger(65_374_576);
    const header = xdr.LedgerHeaderHistoryEntry.fromXDR(boundary.headerXdr, "base64");
    const boundaryOffers: OfferValue[] = [
      {
        seller: "GCTLAKZD4LTTBJHJSSCQ72WV6ED235VBVFEGZDENSNTP7LOWN3T4LZAJ",
        offerId: (header.header.idPool - 2n).toString(),
        sellingAsset: "native",
        buyingAsset: "LIL:GBAASUPEINF2XYZC3MZGXKK5ANT32XPA6QH2PMQWUJBQK2I6F6V3DD54",
        amountStroops: 100n,
        priceN: 1_009_979_804,
        priceD: 101,
      },
      {
        seller: "GCTLAKZD4LTTBJHJSSCQ72WV6ED235VBVFEGZDENSNTP7LOWN3T4LZAJ",
        offerId: (header.header.idPool - 1n).toString(),
        sellingAsset: "native",
        buyingAsset: "LIL:GBAASUPEINF2XYZC3MZGXKK5ANT32XPA6QH2PMQWUJBQK2I6F6V3DD54",
        amountStroops: 200n,
        priceN: 1_009_979_804,
        priceD: 101,
      },
    ];
    const inserted = insertHypotheticalOffer({
      boundaryLedger: boundary.sequence,
      ledgerHeaderXdr: boundary.headerXdr,
      placement: "first-id-allocation-next-ledger",
      pair: pairs.lilXlm,
      side: "bids",
      priceN: 101,
      priceD: 1_009_979_804,
      amountSellingStroops: 100n,
      activeOffers: boundaryOffers,
      activeOffersComplete: true,
    });

    expect(inserted.status).toBe("inserted");
    expect(inserted.priorityOfferId).toBe((header.header.idPool + 1n).toString());
    expect(inserted.queueAheadOfferIds).toEqual([
      (header.header.idPool - 2n).toString(),
      (header.header.idPool - 1n).toString(),
    ]);
    expect(inserted.orderedSameSideOffers?.at(-1)?.source).toBe("hypothetical");
    expect(inserted.assumptions).toContain(
      "Observed later transactions are not counterfactually re-executed.",
    );
    expect("fill" in inserted).toBe(false);

    const ambiguous = insertHypotheticalOffer({
      boundaryLedger: boundary.sequence,
      ledgerHeaderXdr: boundary.headerXdr,
      placement: "unspecified-within-next-ledger",
      pair: pairs.lilXlm,
      side: "bids",
      priceN: 101,
      priceD: 1_009_979_804,
      amountSellingStroops: 100n,
      activeOffers: boundaryOffers,
      activeOffersComplete: true,
    });
    const incomplete = insertHypotheticalOffer({
      boundaryLedger: boundary.sequence,
      ledgerHeaderXdr: boundary.headerXdr,
      placement: "first-id-allocation-next-ledger",
      pair: pairs.lilXlm,
      side: "bids",
      priceN: 101,
      priceD: 1_009_979_804,
      amountSellingStroops: 100n,
      activeOffers: boundaryOffers,
      activeOffersComplete: false,
    });
    const crossing = insertHypotheticalOffer({
      boundaryLedger: boundary.sequence,
      ledgerHeaderXdr: boundary.headerXdr,
      placement: "first-id-allocation-next-ledger",
      pair: pairs.lilXlm,
      side: "asks",
      priceN: 1,
      priceD: 100_000_000,
      amountSellingStroops: 100n,
      activeOffers: boundaryOffers,
      activeOffersComplete: true,
    });

    expect(ambiguous.status).toBe("uncertain");
    expect(ambiguous.reason).toBe("insertion_position_unknown_within_next_ledger");
    expect(ambiguous.queueAheadBaseStroops).toBeNull();
    expect(incomplete.status).toBe("uncertain");
    expect(incomplete.reason).toBe("active_offer_state_incomplete");
    expect(crossing.status).toBe("uncertain");
    expect(crossing.reason).toBe("hypothetical_order_would_not_be_passive");
  });
});
