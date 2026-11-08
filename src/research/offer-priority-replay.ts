import { xdr } from "@stellar/stellar-sdk";

import {
  extractOfferEvents,
  type LedgerRecord,
  type OfferLifecycleEvent,
  type OfferValue,
  type ResearchPair,
} from "./offer-ledger-poc.js";

export interface PrioritizedOffer {
  key: string;
  seller: string | null;
  offerId: string;
  side: "bids" | "asks";
  priceN: number;
  priceD: number;
  amountBaseStroops: bigint;
  source: "ledger" | "hypothetical";
  corePrice: number;
}

export interface OfferPriorityReplayResult {
  valid: boolean;
  reasons: string[];
  coverage: "observed-offer-events-only";
  eventsApplied: number;
  bids: PrioritizedOffer[];
  asks: PrioritizedOffer[];
}

export interface OfferPriorityRangeResult extends OfferPriorityReplayResult {
  ledgerRangeComplete: boolean;
}

export interface HypotheticalOrderRequest {
  boundaryLedger: number;
  ledgerHeaderXdr: string;
  placement: "first-id-allocation-next-ledger" | "unspecified-within-next-ledger";
  pair: ResearchPair;
  side: "bids" | "asks";
  priceN: number;
  priceD: number;
  amountSellingStroops: bigint;
  activeOffers: readonly OfferValue[];
  activeOffersComplete: boolean;
}

export interface HypotheticalInsertionResult {
  status: "inserted" | "uncertain";
  reason: string | null;
  assumptions: string[];
  priorityOfferId: string | null;
  queueAheadOfferIds: string[] | null;
  queueAheadBaseStroops: string | null;
  orderedSameSideOffers: PrioritizedOffer[] | null;
}

const INT64_MAX = (1n << 63n) - 1n;
const INT32_MAX = 2_147_483_647;

function assetId(asset: ResearchPair["base"]): string {
  if (asset.type === "native") {
    return "native";
  }
  if (!asset.code || !asset.issuer) {
    throw new Error("Credit asset is missing a code or issuer");
  }
  return `${asset.code}:${asset.issuer}`;
}

function offerIdNumber(offerId: string): bigint {
  if (!/^\d+$/.test(offerId)) {
    throw new Error(`Invalid Stellar offer ID ${offerId}`);
  }
  const parsed = BigInt(offerId);
  if (parsed <= 0n || parsed > INT64_MAX) {
    throw new Error(`Invalid Stellar offer ID ${offerId}`);
  }
  return parsed;
}

function priorityOffer(
  offer: OfferValue,
  pair: ResearchPair,
  source: PrioritizedOffer["source"],
): PrioritizedOffer {
  const base = assetId(pair.base);
  const quote = assetId(pair.quote);
  if (offer.priceN <= 0 || offer.priceD <= 0 || offer.amountStroops <= 0n) {
    throw new Error(`Invalid offer values for ${offer.seller}:${offer.offerId}`);
  }
  offerIdNumber(offer.offerId);

  if (offer.sellingAsset === base && offer.buyingAsset === quote) {
    return {
      key: `${offer.seller}:${offer.offerId}`,
      seller: offer.seller,
      offerId: offer.offerId,
      side: "asks",
      priceN: offer.priceN,
      priceD: offer.priceD,
      amountBaseStroops: offer.amountStroops,
      source,
      corePrice: offer.priceN / offer.priceD,
    };
  }
  if (offer.sellingAsset === quote && offer.buyingAsset === base) {
    return {
      key: `${offer.seller}:${offer.offerId}`,
      seller: offer.seller,
      offerId: offer.offerId,
      side: "bids",
      priceN: offer.priceD,
      priceD: offer.priceN,
      amountBaseStroops: (offer.amountStroops * BigInt(offer.priceN)) / BigInt(offer.priceD),
      source,
      corePrice: offer.priceN / offer.priceD,
    };
  }
  throw new Error(`Offer ${offer.seller}:${offer.offerId} is outside the configured pair`);
}

function compareOfferEntries(left: PrioritizedOffer, right: PrioritizedOffer): number {
  if (left.side !== right.side) {
    throw new Error("Cannot compare priority across opposite sides of the order book");
  }
  if (left.corePrice !== right.corePrice) {
    return left.corePrice < right.corePrice ? -1 : 1;
  }
  const leftId = offerIdNumber(left.offerId);
  const rightId = offerIdNumber(right.offerId);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

export function compareOfferPriority(
  left: OfferValue,
  right: OfferValue,
  pair: ResearchPair,
): number {
  return compareOfferEntries(
    priorityOffer(left, pair, "ledger"),
    priorityOffer(right, pair, "ledger"),
  );
}

function sameOffer(left: OfferValue, right: OfferValue): boolean {
  return (
    left.seller === right.seller
    && left.offerId === right.offerId
    && left.sellingAsset === right.sellingAsset
    && left.buyingAsset === right.buyingAsset
    && left.amountStroops === right.amountStroops
    && left.priceN === right.priceN
    && left.priceD === right.priceD
  );
}

function offerKey(offer: OfferValue): string {
  return `${offer.seller}:${offer.offerId}`;
}

function compareEventOrder(
  left: OfferLifecycleEvent,
  right: OfferLifecycleEvent,
): number {
  const leftOrder = [
    left.ledger,
    left.transactionIndex,
    left.operationIndex,
    left.changeIndex,
  ];
  const rightOrder = [
    right.ledger,
    right.transactionIndex,
    right.operationIndex,
    right.changeIndex,
  ];
  for (let index = 0; index < leftOrder.length; index += 1) {
    const difference = leftOrder[index]! - rightOrder[index]!;
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function orderedOffers(
  offers: Iterable<OfferValue>,
  pair: ResearchPair,
  side: "bids" | "asks",
): PrioritizedOffer[] {
  return [...offers]
    .map((offer) => priorityOffer(offer, pair, "ledger"))
    .filter((offer) => offer.side === side)
    .sort(compareOfferEntries);
}

export function replayOfferPriority(
  events: readonly OfferLifecycleEvent[],
  pair: ResearchPair,
): OfferPriorityReplayResult {
  const reasons: string[] = [];
  const active = new Map<string, OfferValue>();
  const removed = new Set<string>();
  const seenEventOrders = new Set<string>();
  let priorEvent: OfferLifecycleEvent | null = null;
  let priorCreatedOfferId: bigint | null = null;

  for (const event of events) {
    if (
      !Number.isSafeInteger(event.ledger)
      || event.ledger < 1
      || !Number.isSafeInteger(event.transactionIndex)
      || event.transactionIndex < 0
      || !Number.isSafeInteger(event.operationIndex)
      || event.operationIndex < -1
      || !Number.isSafeInteger(event.changeIndex)
      || event.changeIndex < 0
    ) {
      reasons.push("invalid_offer_event_position");
      continue;
    }
    if (priorEvent && compareEventOrder(priorEvent, event) > 0) {
      reasons.push("offer_event_order_regressed");
    }
    priorEvent = event;

    const orderKey = [
      event.ledger,
      event.transactionIndex,
      event.operationIndex,
      event.changeIndex,
    ].join(":");
    if (seenEventOrders.has(orderKey)) {
      reasons.push(`duplicate_offer_change:${orderKey}`);
      continue;
    }
    seenEventOrders.add(orderKey);

    const keyOffer = event.after ?? event.before;
    if (!keyOffer || event.offerKey !== offerKey(keyOffer)) {
      reasons.push(`offer_event_key_mismatch:${event.offerKey}`);
      continue;
    }

    if (event.type === "created") {
      if (!event.after || event.before) {
        reasons.push(`invalid_created_offer_event:${event.offerKey}`);
        continue;
      }
      const createdOfferId = offerIdNumber(event.after.offerId);
      if (priorCreatedOfferId !== null && createdOfferId <= priorCreatedOfferId) {
        reasons.push(`created_offer_id_not_monotonic:${event.offerKey}`);
      }
      priorCreatedOfferId = createdOfferId;
      if (active.has(event.offerKey) || removed.has(event.offerKey)) {
        reasons.push(`duplicate_offer_creation:${event.offerKey}`);
        continue;
      }
      active.set(event.offerKey, event.after);
      continue;
    }

    if (event.type === "restored") {
      if (!event.after || event.before) {
        reasons.push(`invalid_restored_offer_event:${event.offerKey}`);
        continue;
      }
      if (active.has(event.offerKey)) {
        reasons.push(`restored_offer_already_active:${event.offerKey}`);
        continue;
      }
      removed.delete(event.offerKey);
      active.set(event.offerKey, event.after);
      continue;
    }

    if (!event.before) {
      reasons.push(`missing_prior_offer_state:${event.offerKey}`);
      continue;
    }
    if (event.type === "updated" && !event.after) {
      reasons.push(`missing_updated_offer_state:${event.offerKey}`);
      continue;
    }
    if (event.type === "removed" && event.after) {
      reasons.push(`removed_offer_has_after_state:${event.offerKey}`);
      continue;
    }
    if (event.after && offerKey(event.after) !== event.offerKey) {
      reasons.push(`offer_identity_changed_by_update:${event.offerKey}`);
      continue;
    }

    let current = active.get(event.offerKey);
    if (!current && !removed.has(event.offerKey)) {
      current = event.before;
      active.set(event.offerKey, current);
    }
    if (!current || !sameOffer(current, event.before)) {
      reasons.push(`offer_before_state_mismatch:${event.offerKey}`);
      continue;
    }

    if (event.type === "updated") {
      active.set(event.offerKey, event.after!);
    } else {
      active.delete(event.offerKey);
      removed.add(event.offerKey);
    }
  }

  const values = [...active.values()];
  const bids = orderedOffers(values, pair, "bids");
  const asks = orderedOffers(values, pair, "asks");
  const uniqueReasons = [...new Set(reasons)];
  return {
    valid: uniqueReasons.length === 0,
    reasons: uniqueReasons,
    coverage: "observed-offer-events-only",
    eventsApplied: events.length,
    bids,
    asks,
  };
}

export function replayOfferPriorityRange(
  startLedger: number,
  endLedger: number,
  ledgers: readonly LedgerRecord[],
  pair: ResearchPair,
): OfferPriorityRangeResult {
  const rangeReasons: string[] = [];
  const events: OfferLifecycleEvent[] = [];
  let expectedSequence = startLedger + 1;
  if (!Number.isSafeInteger(startLedger) || !Number.isSafeInteger(endLedger) || endLedger <= startLedger) {
    rangeReasons.push("invalid_ledger_range");
  }
  for (const ledger of ledgers) {
    if (ledger.sequence < expectedSequence) {
      rangeReasons.push(`ledger_sequence_regressed_or_duplicated:${ledger.sequence}`);
    } else if (ledger.sequence > expectedSequence) {
      rangeReasons.push(`missing_ledger_sequence:${expectedSequence}`);
      expectedSequence = ledger.sequence + 1;
    } else {
      expectedSequence += 1;
    }
    if (ledger.sequence > endLedger) {
      rangeReasons.push(`ledger_outside_expected_range:${ledger.sequence}`);
    }
    events.push(...extractOfferEvents(ledger, pair));
  }
  if (ledgers.length === 0) {
    rangeReasons.push("ledger_range_empty");
  }
  if (expectedSequence <= endLedger) {
    rangeReasons.push(`missing_ledger_sequence:${expectedSequence}`);
  }
  const replay = replayOfferPriority(events, pair);
  const uniqueReasons = [...new Set([...replay.reasons, ...rangeReasons])];
  return {
    ...replay,
    valid: replay.valid && rangeReasons.length === 0,
    reasons: uniqueReasons,
    ledgerRangeComplete: rangeReasons.length === 0,
  };
}

function compareRational(
  leftN: number,
  leftD: number,
  rightN: number,
  rightD: number,
): number {
  const left = BigInt(leftN) * BigInt(rightD);
  const right = BigInt(rightN) * BigInt(leftD);
  return left < right ? -1 : left > right ? 1 : 0;
}

function uncertainInsertion(reason: string): HypotheticalInsertionResult {
  return {
    status: "uncertain",
    reason,
    assumptions: [
      "The hypothetical order is assumed valid, funded, and accepted only when insertion is classified as inserted.",
      "The supplied offer set must be complete at the specified ledger boundary.",
      "Observed later transactions are not counterfactually re-executed.",
    ],
    priorityOfferId: null,
    queueAheadOfferIds: null,
    queueAheadBaseStroops: null,
    orderedSameSideOffers: null,
  };
}

export function insertHypotheticalOffer(
  request: HypotheticalOrderRequest,
): HypotheticalInsertionResult {
  if (request.placement !== "first-id-allocation-next-ledger") {
    return uncertainInsertion("insertion_position_unknown_within_next_ledger");
  }
  if (!request.activeOffersComplete) {
    return uncertainInsertion("active_offer_state_incomplete");
  }
  if (
    !Number.isSafeInteger(request.boundaryLedger)
    || request.boundaryLedger < 1
    || !Number.isSafeInteger(request.priceN)
    || !Number.isSafeInteger(request.priceD)
    || request.priceN <= 0
    || request.priceD <= 0
    || request.priceN > INT32_MAX
    || request.priceD > INT32_MAX
    || request.amountSellingStroops <= 0n
  ) {
    return uncertainInsertion("invalid_hypothetical_offer_parameters");
  }

  const header = xdr.LedgerHeaderHistoryEntry.fromXDR(request.ledgerHeaderXdr, "base64");
  if (header.header.ledgerSeq !== request.boundaryLedger) {
    return uncertainInsertion("ledger_header_does_not_match_boundary");
  }
  const lastUsedId = header.header.idPool;
  const nextId = lastUsedId + 1n;
  if (nextId > INT64_MAX) {
    return uncertainInsertion("offer_id_pool_exhausted");
  }

  const existing = request.activeOffers.map((offer) =>
    priorityOffer(offer, request.pair, "ledger")
  );
  const seenOfferIds = new Set<string>();
  for (const offer of existing) {
    if (seenOfferIds.has(offer.offerId)) {
      return uncertainInsertion("duplicate_active_offer_id");
    }
    seenOfferIds.add(offer.offerId);
  }
  if (existing.some((offer) => offerIdNumber(offer.offerId) > lastUsedId)) {
    return uncertainInsertion("active_offer_id_exceeds_boundary_id_pool");
  }
  const ownSide = existing.filter((offer) => offer.side === request.side);
  const oppositeSide = existing.filter((offer) => offer.side !== request.side);
  const offerId = nextId.toString();
  const rawPriceN = request.side === "asks" ? request.priceN : request.priceD;
  const rawPriceD = request.side === "asks" ? request.priceD : request.priceN;
  const hypothetical: PrioritizedOffer = {
    key: `hypothetical:${offerId}`,
    seller: null,
    offerId,
    side: request.side,
    priceN: request.priceN,
    priceD: request.priceD,
    amountBaseStroops: request.side === "asks"
      ? request.amountSellingStroops
      : (request.amountSellingStroops * BigInt(rawPriceN)) / BigInt(rawPriceD),
    source: "hypothetical",
    corePrice: rawPriceN / rawPriceD,
  };

  const bestOpposite = oppositeSide.sort(compareOfferEntries)[0];
  if (bestOpposite) {
    const crossing = request.side === "bids"
      ? compareRational(request.priceN, request.priceD, bestOpposite.priceN, bestOpposite.priceD) >= 0
      : compareRational(request.priceN, request.priceD, bestOpposite.priceN, bestOpposite.priceD) <= 0;
    if (crossing) {
      return uncertainInsertion("hypothetical_order_would_not_be_passive");
    }
  }

  const orderedSameSideOffers = [...ownSide, hypothetical].sort(compareOfferEntries);
  const queueAhead = orderedSameSideOffers.filter((offer) =>
    offer !== hypothetical && compareOfferEntries(offer, hypothetical) < 0
  );
  const queueAheadBaseStroops = queueAhead.reduce(
    (total, offer) => total + offer.amountBaseStroops,
    0n,
  );

  return {
    status: "inserted",
    reason: null,
    assumptions: [
      "The hypothetical order is valid and funded.",
      "The hypothetical order is accepted as the first operation to allocate a global ID in the ledger after the boundary.",
      "The assigned priority ID is the boundary ledger idPool plus one.",
      "The supplied offer set is complete for this pair at the boundary.",
      "Observed later transactions are not counterfactually re-executed.",
    ],
    priorityOfferId: offerId,
    queueAheadOfferIds: queueAhead.map((offer) => offer.offerId),
    queueAheadBaseStroops: queueAheadBaseStroops.toString(),
    orderedSameSideOffers,
  };
}
