import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { xdr } from "@stellar/stellar-sdk";

export interface ResearchAsset {
  type: "native" | "credit";
  code?: string;
  issuer?: string;
}

function assetLabel(asset: ResearchAsset): string {
  if (asset.type === "native") {
    return "XLM";
  }
  return assetId(asset);
}

export interface ResearchPair {
  base: ResearchAsset;
  quote: ResearchAsset;
}

export interface LedgerRecord {
  sequence: number;
  hash: string;
  ledgerCloseTime: string;
  headerXdr: string;
  metadataXdr: string;
}

export interface BookLevel {
  priceN: number;
  priceD: number;
  amountStroops: bigint;
}

export interface BookSnapshot {
  ledger: number;
  requestStartedAt: string;
  capturedAt: string;
  source: string;
  raw: string;
  bids: BookLevel[];
  asks: BookLevel[];
  truncated: {
    bids: boolean;
    asks: boolean;
  };
}

export interface OfferValue {
  seller: string;
  offerId: string;
  sellingAsset: string;
  buyingAsset: string;
  amountStroops: bigint;
  priceN: number;
  priceD: number;
}

export interface OfferLifecycleEvent {
  ledger: number;
  transactionIndex: number;
  operationIndex: number;
  changeIndex: number;
  offerKey: string;
  type: "created" | "updated" | "removed" | "restored";
  before: OfferValue | null;
  after: OfferValue | null;
}

export interface ReplayResult {
  valid: boolean;
  reasons: string[];
  events: OfferLifecycleEvent[];
  levels: {
    bids: BookLevel[];
    asks: BookLevel[];
  };
  roundingAllowanceStroops: Map<string, bigint>;
}

export interface ValidationResult {
  passed: boolean;
  coverage: string[];
  priceLevelsCompared: {
    bids: number;
    asks: number;
  };
  mismatches: Array<{
    side: "bids" | "asks";
    price: string;
    reconstructedStroops: string;
    horizonStroops: string;
    toleranceStroops: string;
  }>;
  reasons: string[];
}

export interface ProviderHealth {
  status: string;
  latestLedger: number;
  oldestLedger: number;
  ledgerRetentionWindow: number;
}

export interface CounterfactualBound {
  side: "buy" | "sell";
  insertedAfterLedger: number;
  limitPrice: string;
  orderSizeBaseStroops: string;
  queueAheadBaseStroops: string;
  observedGrossDepletionBaseStroops: string;
  lowerBoundFillBaseStroops: string;
  upperBoundFillBaseStroops: string;
  classification: "upper_bound_only";
}

const STROOPS_PER_UNIT = 10_000_000n;
const DEFAULT_HORIZON_URL = "https://horizon.stellar.org";
const DEFAULT_RPC_URL = "https://archive-rpc.lightsail.network/";
const MAX_SNAPSHOT_LEVELS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assetId(asset: ResearchAsset): string {
  if (asset.type === "native") {
    return "native";
  }
  if (!asset.code || !asset.issuer) {
    throw new Error("Credit asset is missing a code or issuer");
  }
  return `${asset.code}:${asset.issuer}`;
}

function xdrAssetId(asset: xdr.Asset): string {
  const json: unknown = asset.toJSON();
  if (json === "native") {
    return "native";
  }
  if (!isRecord(json)) {
    throw new Error("Unsupported XDR asset representation");
  }
  const alpha4 = json.credit_alphanum4;
  const alpha12 = json.credit_alphanum12;
  const credit = isRecord(alpha4) ? alpha4 : isRecord(alpha12) ? alpha12 : null;
  if (
    !credit
    || typeof credit.asset_code !== "string"
    || typeof credit.issuer !== "string"
  ) {
    throw new Error("Unsupported credit asset in offer ledger entry");
  }
  return `${credit.asset_code}:${credit.issuer}`;
}

function offerValue(entry: xdr.LedgerEntry): OfferValue | null {
  if (entry.data.type !== "offer") {
    return null;
  }
  const offer = entry.data.offer;
  const seller = offer.sellerId.toJSON();
  if (typeof seller !== "string" || offer.price.n <= 0 || offer.price.d <= 0) {
    throw new Error("Malformed offer ledger entry");
  }
  return {
    seller,
    offerId: offer.offerId.toString(),
    sellingAsset: xdrAssetId(offer.selling),
    buyingAsset: xdrAssetId(offer.buying),
    amountStroops: offer.amount,
    priceN: offer.price.n,
    priceD: offer.price.d,
  };
}

function keyForOffer(value: Pick<OfferValue, "seller" | "offerId">): string {
  return `${value.seller}:${value.offerId}`;
}

function matchesPair(offer: OfferValue, pair: ResearchPair): boolean {
  const base = assetId(pair.base);
  const quote = assetId(pair.quote);
  return (
    (offer.sellingAsset === base && offer.buyingAsset === quote)
    || (offer.sellingAsset === quote && offer.buyingAsset === base)
  );
}

function transactionOperationChanges(
  meta: xdr.TransactionMeta,
): Array<{ operationIndex: number; changes: xdr.LedgerEntryChange[] }> {
  switch (meta.type) {
    case "operations":
      return meta.operations.map((operation, operationIndex) => ({
        operationIndex,
        changes: operation.changes,
      }));
    case "v1":
      return [
        { operationIndex: -1, changes: meta.v1.txChanges },
        ...meta.v1.operations.map((operation, operationIndex) => ({
          operationIndex,
          changes: operation.changes,
        })),
      ];
    case "v2":
      return [
        { operationIndex: -1, changes: meta.v2.txChangesBefore },
        ...meta.v2.operations.map((operation, operationIndex) => ({
          operationIndex,
          changes: operation.changes,
        })),
        { operationIndex: meta.v2.operations.length, changes: meta.v2.txChangesAfter },
      ];
    case "v3":
      return [
        { operationIndex: -1, changes: meta.v3.txChangesBefore },
        ...meta.v3.operations.map((operation, operationIndex) => ({
          operationIndex,
          changes: operation.changes,
        })),
        { operationIndex: meta.v3.operations.length, changes: meta.v3.txChangesAfter },
      ];
    case "v4":
      return [
        { operationIndex: -1, changes: meta.v4.txChangesBefore },
        ...meta.v4.operations.map((operation, operationIndex) => ({
          operationIndex,
          changes: operation.changes,
        })),
        { operationIndex: meta.v4.operations.length, changes: meta.v4.txChangesAfter },
      ];
  }
}

function offerIdFromKey(key: xdr.LedgerKey): string | null {
  if (key.type !== "offer") {
    return null;
  }
  const seller = key.value.sellerId.toJSON();
  return typeof seller === "string"
    ? keyForOffer({ seller, offerId: key.value.offerId.toString() })
    : null;
}

export function extractOfferEvents(
  ledger: LedgerRecord,
  pair: ResearchPair,
): OfferLifecycleEvent[] {
  const closeMeta = xdr.LedgerCloseMeta.fromXDR(ledger.metadataXdr, "base64");
  if (closeMeta.type !== "v2") {
    throw new Error(
      `Unsupported LedgerCloseMeta ${closeMeta.type} at ledger ${ledger.sequence}`,
    );
  }
  if (closeMeta.value.ledgerHeader.header.ledgerSeq !== ledger.sequence) {
    throw new Error(`Metadata header sequence does not match ledger ${ledger.sequence}`);
  }

  const events: OfferLifecycleEvent[] = [];
  for (const [transactionIndex, transaction] of closeMeta.value.txProcessing.entries()) {
    const changeGroups = transactionOperationChanges(transaction.txApplyProcessing);
    const stateByKey = new Map<string, OfferValue>();
    for (const group of changeGroups) {
      for (const [changeIndex, change] of group.changes.entries()) {
        if (change.type === "ledgerEntryState") {
          const prior = offerValue(change.state);
          if (prior && matchesPair(prior, pair)) {
            stateByKey.set(keyForOffer(prior), prior);
          }
          continue;
        }

        if (change.type === "ledgerEntryCreated" || change.type === "ledgerEntryRestored") {
          const after = offerValue(change.value);
          if (!after || !matchesPair(after, pair)) {
            continue;
          }
          events.push({
            ledger: ledger.sequence,
            transactionIndex,
            operationIndex: group.operationIndex,
            changeIndex,
            offerKey: keyForOffer(after),
            type: change.type === "ledgerEntryCreated" ? "created" : "restored",
            before: null,
            after,
          });
          stateByKey.set(keyForOffer(after), after);
          continue;
        }

        if (change.type === "ledgerEntryUpdated") {
          const after = offerValue(change.updated);
          if (!after) {
            continue;
          }
          const offerKey = keyForOffer(after);
          const before = stateByKey.get(offerKey) ?? null;
          if (
            (before && matchesPair(before, pair))
            || matchesPair(after, pair)
          ) {
            events.push({
              ledger: ledger.sequence,
              transactionIndex,
              operationIndex: group.operationIndex,
              changeIndex,
              offerKey,
              type: "updated",
              before,
              after,
            });
          }
          stateByKey.set(offerKey, after);
          continue;
        }

        if (change.type !== "ledgerEntryRemoved") {
          continue;
        }
        const offerKey = offerIdFromKey(change.removed);
        if (!offerKey) {
          continue;
        }
        const before = stateByKey.get(offerKey) ?? null;
        if (before && matchesPair(before, pair)) {
          events.push({
            ledger: ledger.sequence,
            transactionIndex,
            operationIndex: group.operationIndex,
            changeIndex,
            offerKey,
            type: "removed",
            before,
            after: null,
          });
        }
        stateByKey.delete(offerKey);
      }
    }
  }
  return events;
}

function normalizedBookPrice(offer: OfferValue, pair: ResearchPair): {
  side: "bids" | "asks";
  priceN: number;
  priceD: number;
  amountStroops: bigint;
} {
  const base = assetId(pair.base);
  const quote = assetId(pair.quote);
  if (offer.sellingAsset === base && offer.buyingAsset === quote) {
    return {
      side: "asks",
      priceN: offer.priceN,
      priceD: offer.priceD,
      amountStroops: offer.amountStroops,
    };
  }
  if (offer.sellingAsset === quote && offer.buyingAsset === base) {
    return {
      side: "bids",
      priceN: offer.priceD,
      priceD: offer.priceN,
      amountStroops: (offer.amountStroops * BigInt(offer.priceN)) / BigInt(offer.priceD),
    };
  }
  throw new Error("Offer does not belong to configured pair");
}

function priceKey(priceN: number, priceD: number): string {
  const divisor = gcd(BigInt(priceN), BigInt(priceD));
  return `${BigInt(priceN) / divisor}/${BigInt(priceD) / divisor}`;
}

function levelMap(levels: BookLevel[]): Map<string, bigint> {
  return new Map(
    levels.map((level) => [priceKey(level.priceN, level.priceD), level.amountStroops]),
  );
}

function sortLevels(side: "bids" | "asks", values: Map<string, bigint>): BookLevel[] {
  const levels = [...values.entries()]
    .filter(([, amount]) => amount > 0n)
    .map(([key, amount]) => {
      const [priceN, priceD] = key.split("/").map(Number);
      if (!priceN || !priceD) {
        throw new Error(`Invalid price key ${key}`);
      }
      return { priceN, priceD, amountStroops: amount };
    });
  return levels.sort((a, b) => {
    const left = BigInt(a.priceN) * BigInt(b.priceD);
    const right = BigInt(b.priceN) * BigInt(a.priceD);
    return side === "bids"
      ? (left > right ? -1 : left < right ? 1 : 0)
      : (left < right ? -1 : left > right ? 1 : 0);
  });
}

function addLevel(
  levels: Map<string, bigint>,
  side: "bids" | "asks",
  priceN: number,
  priceD: number,
  delta: bigint,
  reason: string[],
): void {
  const key = priceKey(priceN, priceD);
  const current = levels.get(key);
  if (delta < 0n && current === undefined) {
    reason.push(`missing_initial_or_prior_offer_level:${side}:${key}`);
    return;
  }
  const next = (current ?? 0n) + delta;
  if (next < 0n) {
    reason.push(`negative_reconstructed_depth:${side}:${key}`);
    return;
  }
  if (next === 0n) {
    levels.delete(key);
  } else {
    levels.set(key, next);
  }
}

function amountAtPrice(offer: OfferValue, pair: ResearchPair): {
  side: "bids" | "asks";
  priceN: number;
  priceD: number;
  amountStroops: bigint;
} {
  return normalizedBookPrice(offer, pair);
}

function coveredBySnapshot(
  side: "bids" | "asks",
  priceN: number,
  priceD: number,
  snapshot: BookSnapshot,
): boolean {
  if (!snapshot.truncated[side]) {
    return true;
  }
  const worstVisible = snapshot[side].at(-1);
  if (!worstVisible) {
    return false;
  }
  const eventPrice = BigInt(priceN) * BigInt(worstVisible.priceD);
  const cutoffPrice = BigInt(worstVisible.priceN) * BigInt(priceD);
  return side === "bids" ? eventPrice >= cutoffPrice : eventPrice <= cutoffPrice;
}

export function applyOfferEventsToBook(
  start: BookSnapshot,
  events: OfferLifecycleEvent[],
  pair: ResearchPair,
): ReplayResult {
  const reasons: string[] = [];
  const roundingAllowanceStroops = new Map<string, bigint>();
  const bids = levelMap(start.bids);
  const asks = levelMap(start.asks);
  let priorEventOrder: [number, number, number, number] | null = null;
  const seenEventIds = new Set<string>();
  const createdAfterStart = new Set<string>();

  for (const event of events) {
    const eventOrder: [number, number, number, number] = [
      event.ledger,
      event.transactionIndex,
      event.operationIndex,
      event.changeIndex,
    ];
    let orderComparison = 0;
    if (priorEventOrder) {
      for (let index = 0; index < eventOrder.length; index += 1) {
        if (eventOrder[index] !== priorEventOrder[index]) {
          orderComparison = eventOrder[index]! < priorEventOrder[index]! ? -1 : 1;
          break;
        }
      }
    }
    if (orderComparison < 0) {
      reasons.push("offer_event_order_regressed");
    }
    priorEventOrder = eventOrder;
    const eventId = eventOrder.join(":");
    if (seenEventIds.has(eventId)) {
      reasons.push(`duplicate_offer_change:${eventId}`);
      continue;
    }
    seenEventIds.add(eventId);

    if ((event.type === "updated" || event.type === "removed") && !event.before) {
      reasons.push(`missing_prior_offer_state:${event.offerKey}`);
      continue;
    }
    if (event.type === "restored") {
      reasons.push(`restored_offer_not_supported:${event.offerKey}`);
      continue;
    }
    if (event.type === "created") {
      createdAfterStart.add(event.offerKey);
    }

    if (event.before && matchesPair(event.before, pair)) {
      const prior = amountAtPrice(event.before, pair);
      const priorLevels = prior.side === "bids" ? bids : asks;
      const priorPriceKey = priceKey(prior.priceN, prior.priceD);
      if (
        priorLevels.has(priorPriceKey)
        || coveredBySnapshot(prior.side, prior.priceN, prior.priceD, start)
      ) {
        const allowanceKey = `${prior.side}:${priorPriceKey}`;
        roundingAllowanceStroops.set(
          allowanceKey,
          (roundingAllowanceStroops.get(allowanceKey) ?? 0n) + 1n,
        );
        addLevel(
          priorLevels,
          prior.side,
          prior.priceN,
          prior.priceD,
          -prior.amountStroops,
          reasons,
        );
      }
    }
    if (event.after && matchesPair(event.after, pair)) {
      const next = amountAtPrice(event.after, pair);
      if (
        createdAfterStart.has(event.offerKey)
        || coveredBySnapshot(next.side, next.priceN, next.priceD, start)
      ) {
        const nextPriceKey = priceKey(next.priceN, next.priceD);
        const allowanceKey = `${next.side}:${nextPriceKey}`;
        roundingAllowanceStroops.set(
          allowanceKey,
          (roundingAllowanceStroops.get(allowanceKey) ?? 0n) + 1n,
        );
        addLevel(
          next.side === "bids" ? bids : asks,
          next.side,
          next.priceN,
          next.priceD,
          next.amountStroops,
          reasons,
        );
      }
    }
  }

  return {
    valid: reasons.length === 0,
    reasons: [...new Set(reasons)],
    events,
    levels: {
      bids: sortLevels("bids", bids),
      asks: sortLevels("asks", asks),
    },
    roundingAllowanceStroops,
  };
}

export function replayOfferEvents(
  start: BookSnapshot,
  ledgers: LedgerRecord[],
  pair: ResearchPair,
): ReplayResult {
  const reasons: string[] = [];
  const events: OfferLifecycleEvent[] = [];
  let expectedSequence = start.ledger + 1;
  for (const ledger of ledgers) {
    if (ledger.sequence !== expectedSequence) {
      reasons.push(`missing_ledger_sequence:${expectedSequence}`);
    }
    expectedSequence = ledger.sequence + 1;
    events.push(...extractOfferEvents(ledger, pair));
  }
  const replay = applyOfferEventsToBook(start, events, pair);
  const lastSequence = ledgers.at(-1)?.sequence ?? start.ledger;
  if (lastSequence + 1 !== expectedSequence) {
    reasons.push("ledger_range_did_not_end_at_last_supplied_sequence");
  }
  return {
    ...replay,
    valid: replay.valid && reasons.length === 0,
    reasons: [...new Set([...replay.reasons, ...reasons])],
  };
}

function rationalPriceKey(level: BookLevel): string {
  return priceKey(level.priceN, level.priceD);
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a === 0n ? 1n : a;
}

function compareSide(
  side: "bids" | "asks",
  reconstructed: BookLevel[],
  horizon: BookLevel[],
  allowance: Map<string, bigint>,
  end: BookSnapshot,
): ValidationResult["mismatches"] {
  const reconstructedByPrice = new Map(
    reconstructed
      .filter((level) => coveredBySnapshot(side, level.priceN, level.priceD, end))
      .map((level) => [rationalPriceKey(level), level]),
  );
  const horizonByPrice = new Map(horizon.map((level) => [rationalPriceKey(level), level]));
  const mismatches: ValidationResult["mismatches"] = [];
  for (const key of new Set([...reconstructedByPrice.keys(), ...horizonByPrice.keys()])) {
    const left = reconstructedByPrice.get(key);
    const right = horizonByPrice.get(key);
    const leftAmount = left?.amountStroops ?? 0n;
    const rightAmount = right?.amountStroops ?? 0n;
    const allowanceKey = left
      ? `${side}:${priceKey(left.priceN, left.priceD)}`
      : right
        ? `${side}:${priceKey(right.priceN, right.priceD)}`
        : "";
    const tolerance = allowance.get(allowanceKey) ?? 1n;
    if (abs(leftAmount - rightAmount) > tolerance) {
      mismatches.push({
        side,
        price: key,
        reconstructedStroops: leftAmount.toString(),
        horizonStroops: rightAmount.toString(),
        toleranceStroops: tolerance.toString(),
      });
    }
  }
  return mismatches;
}

function visiblePriceLevelCount(
  side: "bids" | "asks",
  reconstructed: BookLevel[],
  horizon: BookLevel[],
  end: BookSnapshot,
): number {
  const keys = new Set(
    [...reconstructed, ...horizon]
      .filter((level) => coveredBySnapshot(side, level.priceN, level.priceD, end))
      .map(rationalPriceKey),
  );
  return keys.size;
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

export function validateReconstruction(
  start: BookSnapshot,
  end: BookSnapshot,
  replay: ReplayResult,
): ValidationResult {
  const reasons = [...replay.reasons];
  const coverage: string[] = [];
  if (start.ledger >= end.ledger) {
    reasons.push("snapshot_ledgers_not_increasing");
  }
  for (const side of ["bids", "asks"] as const) {
    if (start.truncated[side] || end.truncated[side]) {
      coverage.push(`${side}:comparison_limited_to_the_worst_price_visible_in_each_snapshot`);
    } else {
      coverage.push(`${side}:complete_depth_returned_by_Horizon`);
    }
  }
  if (replay.events.some((event) => (
    (event.type === "updated" || event.type === "removed") && event.before === null
  ))) {
    reasons.push("offer_change_missing_pre_change_state");
  }
  const mismatches = [
    ...compareSide("bids", replay.levels.bids, end.bids, replay.roundingAllowanceStroops, end),
    ...compareSide("asks", replay.levels.asks, end.asks, replay.roundingAllowanceStroops, end),
  ];
  const priceLevelsCompared = {
    bids: visiblePriceLevelCount("bids", replay.levels.bids, end.bids, end),
    asks: visiblePriceLevelCount("asks", replay.levels.asks, end.asks, end),
  };
  if (mismatches.length > 0) {
    reasons.push("reconstructed_levels_do_not_match_horizon_snapshot");
  }
  return {
    passed: reasons.length === 0,
    coverage,
    priceLevelsCompared,
    mismatches,
    reasons: [...new Set(reasons)],
  };
}

function decimalToStroops(value: string): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) {
    throw new Error(`Invalid Horizon amount ${value}`);
  }
  const fraction = (match[2] ?? "").padEnd(7, "0");
  if (fraction.length > 7 && /[1-9]/.test(fraction.slice(7))) {
    throw new Error(`Horizon amount has more than 7 decimal places: ${value}`);
  }
  return BigInt(match[1]!) * STROOPS_PER_UNIT + BigInt(fraction.slice(0, 7) || "0");
}

function parseBookLevel(value: unknown, side: "bids" | "asks"): BookLevel {
  if (!isRecord(value) || !isRecord(value.price_r)) {
    throw new Error("Malformed Horizon order-book level");
  }
  const n = value.price_r.n;
  const d = value.price_r.d;
  if (
    typeof n !== "number"
    || typeof d !== "number"
    || !Number.isSafeInteger(n)
    || !Number.isSafeInteger(d)
    || n <= 0
    || d <= 0
    || typeof value.amount !== "string"
  ) {
    throw new Error("Invalid Horizon order-book level values");
  }
  const reportedAmount = decimalToStroops(value.amount);
  // Horizon bid amounts are quote-denominated; normalize them to base units.
  const amountStroops = side === "bids"
    ? (reportedAmount * BigInt(d)) / BigInt(n)
    : reportedAmount;
  return { priceN: n, priceD: d, amountStroops };
}

export async function fetchBookSnapshot(
  horizonUrl: string,
  pair: ResearchPair,
): Promise<BookSnapshot> {
  const url = new URL("/order_book", horizonUrl);
  const base = pair.base;
  const quote = pair.quote;
  const addAsset = (prefix: "selling" | "buying", asset: ResearchAsset): void => {
    const type = asset.type === "native"
      ? "native"
      : asset.code && asset.code.length <= 4
        ? "credit_alphanum4"
        : "credit_alphanum12";
    url.searchParams.set(`${prefix}_asset_type`, type);
    if (asset.type === "credit") {
      if (!asset.code || !asset.issuer) {
        throw new Error("Credit pair asset is missing code or issuer");
      }
      url.searchParams.set(`${prefix}_asset_code`, asset.code);
      url.searchParams.set(`${prefix}_asset_issuer`, asset.issuer);
    }
  };
  addAsset("selling", base);
  addAsset("buying", quote);
  url.searchParams.set("limit", String(MAX_SNAPSHOT_LEVELS));

  const requestStartedAt = new Date().toISOString();
  const response = await fetch(url);
  const ledgerHeader = response.headers.get("latest-ledger");
  if (!response.ok) {
    throw new Error(`Horizon order-book request failed: HTTP ${response.status}`);
  }
  if (!ledgerHeader || !/^\d+$/.test(ledgerHeader)) {
    throw new Error("Horizon order-book response has no valid Latest-Ledger header");
  }
  const raw = await response.text();
  const capturedAt = new Date().toISOString();
  const json: unknown = JSON.parse(raw);
  if (!isRecord(json) || !Array.isArray(json.bids) || !Array.isArray(json.asks)) {
    throw new Error("Malformed Horizon order-book response");
  }
  const bids = json.bids.map((level) => parseBookLevel(level, "bids"));
  const asks = json.asks.map((level) => parseBookLevel(level, "asks"));
  if (bids.length === 0 || asks.length === 0) {
    throw new Error("Pair has an empty side; cannot run the bounded book-replay validation");
  }
  return {
    ledger: Number(ledgerHeader),
    requestStartedAt,
    capturedAt,
    source: url.toString(),
    raw,
    bids,
    asks,
    truncated: {
      bids: bids.length >= MAX_SNAPSHOT_LEVELS,
      asks: asks.length >= MAX_SNAPSHOT_LEVELS,
    },
  };
}

async function fetchProviderHealth(rpcUrl: string): Promise<ProviderHealth> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
  });
  if (!response.ok) {
    throw new Error(`RPC getHealth failed: HTTP ${response.status}`);
  }
  const json: unknown = await response.json();
  if (!isRecord(json) || !isRecord(json.result)) {
    throw new Error("RPC getHealth returned an invalid response");
  }
  const result = json.result;
  if (
    typeof result.status !== "string"
    || typeof result.latestLedger !== "number"
    || typeof result.oldestLedger !== "number"
    || typeof result.ledgerRetentionWindow !== "number"
  ) {
    throw new Error("RPC getHealth omitted required retention fields");
  }
  return {
    status: result.status,
    latestLedger: result.latestLedger,
    oldestLedger: result.oldestLedger,
    ledgerRetentionWindow: result.ledgerRetentionWindow,
  };
}

function getConfiguredPair(): ResearchPair {
  const raw = process.env.STELLAR_RESEARCH_PAIR;
  if (!raw) {
    throw new Error("Set STELLAR_RESEARCH_PAIR to the public pair JSON for the POC");
  }
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value) || !isRecord(value.base) || !isRecord(value.quote)) {
    throw new Error("STELLAR_RESEARCH_PAIR must contain base and quote assets");
  }
  const validateAsset = (asset: Record<string, unknown>): ResearchAsset => {
    if (asset.type === "native") {
      return { type: "native" };
    }
    if (
      asset.type === "credit"
      && typeof asset.code === "string"
      && typeof asset.issuer === "string"
    ) {
      return { type: "credit", code: asset.code, issuer: asset.issuer };
    }
    throw new Error("Unsupported asset in STELLAR_RESEARCH_PAIR");
  };
  return { base: validateAsset(value.base), quote: validateAsset(value.quote) };
}

async function fetchLatestHorizonLedger(horizonUrl: string): Promise<number> {
  const response = await fetch(
    new URL("/ledgers?order=desc&limit=1", horizonUrl),
  );
  if (!response.ok) {
    throw new Error(`Horizon ledger poll failed: HTTP ${response.status}`);
  }
  const json: unknown = await response.json();
  if (!isRecord(json) || !isRecord(json._embedded) || !Array.isArray(json._embedded.records)) {
    throw new Error("Malformed Horizon latest-ledger response");
  }
  const first = json._embedded.records[0];
  if (!isRecord(first) || typeof first.sequence !== "number") {
    throw new Error("Horizon latest-ledger response has no sequence");
  }
  return first.sequence;
}

async function fetchLedgerResponse(
  rpcUrl: string,
  startLedger: number,
  count: number,
): Promise<{ raw: string; json: Record<string, unknown>; ledgers: LedgerRecord[] }> {
  if (count < 1 || count > 200) {
    throw new Error(`Requested ledger count ${count} is outside RPC limit 1..200`);
  }
  const raw = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "getLedgers",
    params: {
      startLedger,
      pagination: { limit: count },
      xdrFormat: "base64",
    },
  });
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw,
  });
  if (!response.ok) {
    throw new Error(`RPC getLedgers failed: HTTP ${response.status}`);
  }
  const responseText = await response.text();
  const json: unknown = JSON.parse(responseText);
  if (!isRecord(json) || isRecord(json.error) || !isRecord(json.result)) {
    throw new Error(`RPC getLedgers returned an invalid response: ${responseText.slice(0, 500)}`);
  }
  const rawLedgers = json.result.ledgers;
  if (!Array.isArray(rawLedgers)) {
    throw new Error("RPC getLedgers result has no ledgers array");
  }
  const ledgers: LedgerRecord[] = rawLedgers.map((value, index) => {
    if (
      !isRecord(value)
      || typeof value.sequence !== "number"
      || typeof value.hash !== "string"
      || typeof value.ledgerCloseTime !== "string"
      || typeof value.headerXdr !== "string"
      || typeof value.metadataXdr !== "string"
      || value.metadataXdr.length === 0
    ) {
      throw new Error(`Ledger response at index ${index} lacks required metadata`);
    }
    const header = xdr.LedgerHeaderHistoryEntry.fromXDR(value.headerXdr, "base64");
    const metadata = xdr.LedgerCloseMeta.fromXDR(value.metadataXdr, "base64");
    const metadataHeaderSequence = metadata.type === "v2"
      ? metadata.value.ledgerHeader.header.ledgerSeq
      : null;
    if (
      header.header.ledgerSeq !== value.sequence
      || metadataHeaderSequence !== value.sequence
      || header.hash.toString() !== value.hash
    ) {
      throw new Error(`Ledger/header/metadata identity mismatch at ${value.sequence}`);
    }
    return {
      sequence: value.sequence,
      hash: value.hash,
      ledgerCloseTime: value.ledgerCloseTime,
      headerXdr: value.headerXdr,
      metadataXdr: value.metadataXdr,
    };
  });
  const result = json.result;
  return {
    raw: responseText,
    json: {
      latestLedger: result.latestLedger,
      oldestLedger: result.oldestLedger,
      cursor: result.cursor,
    },
    ledgers,
  };
}

function bookSummary(snapshot: BookSnapshot): Record<string, unknown> {
  return {
    ledger: snapshot.ledger,
    requestStartedAt: snapshot.requestStartedAt,
    capturedAt: snapshot.capturedAt,
    source: snapshot.source,
    checksum: sha256(snapshot.raw),
    bids: snapshot.bids.map(formatLevel),
    asks: snapshot.asks.map(formatLevel),
    truncated: snapshot.truncated,
  };
}

function decimalStroops(value: bigint): string {
  const whole = value / STROOPS_PER_UNIT;
  const fraction = (value % STROOPS_PER_UNIT).toString().padStart(7, "0");
  return `${whole}.${fraction}`;
}

export function formatLevel(level: BookLevel): Record<string, string | number> {
  return {
    priceN: level.priceN,
    priceD: level.priceD,
    amount: decimalStroops(level.amountStroops),
    amountStroops: level.amountStroops.toString(),
  };
}

function formatOfferValue(offer: OfferValue | null): Record<string, string | number> | null {
  if (!offer) {
    return null;
  }
  return {
    seller: offer.seller,
    offerId: offer.offerId,
    sellingAsset: offer.sellingAsset,
    buyingAsset: offer.buyingAsset,
    sellingAmountStroops: offer.amountStroops.toString(),
    priceN: offer.priceN,
    priceD: offer.priceD,
  };
}

function formatOfferEvent(event: OfferLifecycleEvent): Record<string, unknown> {
  return {
    ledger: event.ledger,
    transactionIndex: event.transactionIndex,
    operationIndex: event.operationIndex,
    changeIndex: event.changeIndex,
    offerKey: event.offerKey,
    type: event.type,
    before: formatOfferValue(event.before),
    after: formatOfferValue(event.after),
  };
}

function priceText(level: BookLevel): string {
  return `${level.priceN}/${level.priceD}`;
}

function isAtPrice(
  offer: OfferValue,
  pair: ResearchPair,
  targetSide: "bids" | "asks",
  target: BookLevel,
): boolean {
  if (!matchesPair(offer, pair)) {
    return false;
  }
  const normalized = amountAtPrice(offer, pair);
  return (
    normalized.side === targetSide
    && priceKey(normalized.priceN, normalized.priceD) === rationalPriceKey(target)
  );
}

export function estimateCounterfactualBound(
  start: BookSnapshot,
  events: OfferLifecycleEvent[],
  pair: ResearchPair,
  side: "buy" | "sell",
): CounterfactualBound | null {
  const targetSide = side === "buy" ? "bids" : "asks";
  const best = start[targetSide][0];
  if (!best) {
    return null;
  }
  const createdAfterInsertion = new Set<string>();
  let observedGrossDepletion = 0n;
  for (const event of events) {
    if (event.type === "created") {
      createdAfterInsertion.add(event.offerKey);
      continue;
    }
    if (
      !event.before
      || createdAfterInsertion.has(event.offerKey)
      || !isAtPrice(event.before, pair, targetSide, best)
    ) {
      continue;
    }
    const before = amountAtPrice(event.before, pair);
    let remainingAtPrice = 0n;
    if (event.after && matchesPair(event.after, pair)) {
      const after = amountAtPrice(event.after, pair);
      if (after.side === before.side && priceKey(after.priceN, after.priceD) === rationalPriceKey(best)) {
        remainingAtPrice = after.amountStroops;
      }
    }
    if (before.amountStroops > remainingAtPrice) {
      observedGrossDepletion += before.amountStroops - remainingAtPrice;
    }
  }
  const possibleAfterQueue = observedGrossDepletion > best.amountStroops
    ? observedGrossDepletion - best.amountStroops
    : 0n;
  const upperBound = possibleAfterQueue < STROOPS_PER_UNIT
    ? possibleAfterQueue
    : STROOPS_PER_UNIT;
  return {
    side,
    insertedAfterLedger: start.ledger,
    limitPrice: priceText(best),
    orderSizeBaseStroops: STROOPS_PER_UNIT.toString(),
    queueAheadBaseStroops: best.amountStroops.toString(),
    observedGrossDepletionBaseStroops: observedGrossDepletion.toString(),
    lowerBoundFillBaseStroops: "0",
    upperBoundFillBaseStroops: upperBound.toString(),
    classification: "upper_bound_only",
  };
}

export async function runOfferLedgerPoc(options: {
  ledgerSpan: number;
  horizonUrl?: string;
  rpcUrl?: string;
  dataDirectory?: string;
}): Promise<Record<string, unknown>> {
  const pair = getConfiguredPair();
  const horizonUrl = options.horizonUrl ?? DEFAULT_HORIZON_URL;
  const rpcUrl = options.rpcUrl ?? DEFAULT_RPC_URL;
  const runStartedAt = new Date().toISOString();
  const providerHealthBefore = await fetchProviderHealth(rpcUrl);
  const start = await fetchBookSnapshot(horizonUrl, pair);
  if (start.ledger < providerHealthBefore.oldestLedger) {
    throw new Error(
      `Starting snapshot ledger ${start.ledger} is older than provider retention `
      + `${providerHealthBefore.oldestLedger}`,
    );
  }

  if (!Number.isInteger(options.ledgerSpan) || options.ledgerSpan < 2 || options.ledgerSpan > 20) {
    throw new Error("POC ledger span must be an integer between 2 and 20");
  }
  const span = options.ledgerSpan;
  const targetLedger = start.ledger + span;
  const horizonDeadline = Date.now() + 180_000;
  while (
    (await fetchLatestHorizonLedger(horizonUrl)) < targetLedger
    && Date.now() < horizonDeadline
  ) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  if (Date.now() >= horizonDeadline) {
    throw new Error(`Timed out waiting for Horizon ledger ${targetLedger}`);
  }
  const end = await fetchBookSnapshot(horizonUrl, pair);
  if (end.ledger <= start.ledger || end.ledger - start.ledger > span + 2) {
    throw new Error(
      `Captured snapshot interval ${start.ledger}..${end.ledger} is outside `
      + `the requested bounded span (${span} ledgers)`,
    );
  }
  const providerDeadline = Date.now() + 180_000;
  let providerHealthAfter = await fetchProviderHealth(rpcUrl);
  while (providerHealthAfter.latestLedger < end.ledger && Date.now() < providerDeadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
    providerHealthAfter = await fetchProviderHealth(rpcUrl);
  }
  if (providerHealthAfter.latestLedger < end.ledger) {
    throw new Error(
      `Archival RPC has not closed ledger ${end.ledger}; latest is `
      + `${providerHealthAfter.latestLedger}`,
    );
  }
  if (start.ledger < providerHealthAfter.oldestLedger) {
    throw new Error(
      `Starting snapshot ledger ${start.ledger} fell outside provider retention `
      + `${providerHealthAfter.oldestLedger} during acquisition`,
    );
  }
  const ledgerRequestStartedAt = new Date().toISOString();
  const fetched = await fetchLedgerResponse(rpcUrl, start.ledger + 1, end.ledger - start.ledger);
  const ledgerResponseReceivedAt = new Date().toISOString();
  const expectedSequences = Array.from(
    { length: end.ledger - start.ledger },
    (_, index) => start.ledger + index + 1,
  );
  const actualSequences = fetched.ledgers.map((ledger) => ledger.sequence);
  if (
    actualSequences.length !== expectedSequences.length
    || actualSequences.some((sequence, index) => sequence !== expectedSequences[index])
  ) {
    throw new Error("RPC returned a discontinuous or incomplete ledger range");
  }

  const replay = replayOfferEvents(start, fetched.ledgers, pair);
  const validation = validateReconstruction(start, end, replay);
  const manifest = {
    model: "ledger_offer_delta_poc_v2",
    runStartedAt,
    runCompletedAt: new Date().toISOString(),
    mode: "read-only independent research",
    pair: {
      base: assetId(pair.base),
      quote: assetId(pair.quote),
    },
    horizonSource: horizonUrl,
    rpcSource: rpcUrl,
    providerHealthBefore,
    providerHealthAfter,
    ledgerRequestStartedAt,
    ledgerResponseReceivedAt,
    providerReportedRange: fetched.json,
    requestedLedgerSpan: span,
    ledgerRange: {
      first: start.ledger,
      last: end.ledger,
      includedLedgerMetadata: [start.ledger + 1, end.ledger],
      count: fetched.ledgers.length,
      sequencesContinuous: true,
    },
    snapshots: {
      start: bookSummary(start),
      end: bookSummary(end),
    },
    decoding: {
      ledgerCount: fetched.ledgers.length,
      ledgersWithMetadata: fetched.ledgers.filter((ledger) => ledger.metadataXdr.length > 0).length,
      protocolVersions: [
        ...new Set(fetched.ledgers.map((ledger) => {
          const meta = xdr.LedgerCloseMeta.fromXDR(ledger.metadataXdr, "base64");
          if (meta.type !== "v2") {
            throw new Error(`Unsupported LedgerCloseMeta ${meta.type} in protocol summary`);
          }
          return meta.value.ledgerHeader.header.ledgerVersion;
        })),
      ],
      ledgerCloseMetaVersions: [
        ...new Set(fetched.ledgers.map((ledger) => (
          xdr.LedgerCloseMeta.fromXDR(ledger.metadataXdr, "base64").type
        ))),
      ],
      transactionMetaVersions: fetched.ledgers.reduce<Record<string, number>>((counts, ledger) => {
        const meta = xdr.LedgerCloseMeta.fromXDR(ledger.metadataXdr, "base64");
        if (meta.type !== "v2") {
          throw new Error(`Unsupported LedgerCloseMeta ${meta.type} in metadata summary`);
        }
        for (const transaction of meta.value.txProcessing) {
          const version = transaction.txApplyProcessing.type;
          counts[version] = (counts[version] ?? 0) + 1;
        }
        return counts;
      }, {}),
      transactions: fetched.ledgers.reduce((sum, ledger) => {
        const meta = xdr.LedgerCloseMeta.fromXDR(ledger.metadataXdr, "base64");
        return sum + (meta.type === "v2" ? meta.value.txProcessing.length : 0);
      }, 0),
      pairOfferChanges: replay.events.length,
      created: replay.events.filter((event) => event.type === "created").length,
      updated: replay.events.filter((event) => event.type === "updated").length,
      removed: replay.events.filter((event) => event.type === "removed").length,
      restored: replay.events.filter((event) => event.type === "restored").length,
      missingPriorState: replay.events.filter((event) => (
        (event.type === "updated" || event.type === "removed") && event.before === null
      )).length,
      replayValid: replay.valid,
      replayReasons: replay.reasons,
    },
    validation: {
      passed: validation.passed,
      reasons: validation.reasons,
      mismatches: validation.mismatches,
      coverage: validation.coverage,
      priceLevelsCompared: validation.priceLevelsCompared,
      bestPrices: {
        start: {
          bid: start.bids[0] ? formatLevel(start.bids[0]) : null,
          ask: start.asks[0] ? formatLevel(start.asks[0]) : null,
        },
        reconstructed: {
          bid: replay.levels.bids[0] ? formatLevel(replay.levels.bids[0]) : null,
          ask: replay.levels.asks[0] ? formatLevel(replay.levels.asks[0]) : null,
        },
        end: {
          bid: end.bids[0] ? formatLevel(end.bids[0]) : null,
          ask: end.asks[0] ? formatLevel(end.asks[0]) : null,
        },
      },
      independentOfferCounts: {
        status: "unavailable",
        reason: "Horizon order_book returns aggregated price levels without offer counts; paginated /offers does not provide a coherent historical ledger snapshot.",
      },
      tolerances: "At most one stroop rounding allowance per before/after offer amount on each affected rational price level; all other depth must match exactly.",
    },
    counterfactual: validation.passed
      ? {
          status: "estimated",
          insertionAssumption: "After the start snapshot ledger close, at the same price behind all displayed same-price liquidity.",
          orderSizeBase: `${decimalStroops(STROOPS_PER_UNIT)} ${assetLabel(pair.base)}`,
          bounds: [
            estimateCounterfactualBound(start, replay.events, pair, "buy"),
            estimateCounterfactualBound(start, replay.events, pair, "sell"),
          ].filter((bound): bound is CounterfactualBound => bound !== null),
          limitations: [
            "Lower bound is zero because offer changes cannot distinguish execution from cancellation.",
            "Upper bound treats gross depletion of pre-existing same-price offers as possible execution and is not an actual or confirmed fill.",
            "Order acceptance, exact offer priority, and transaction-level execution attribution are not proven.",
          ],
        }
      : {
          status: "not_run",
          reason: "Independent order-book validation did not pass.",
        },
  };
  const completedDirectory = options.dataDirectory
    ? resolve(options.dataDirectory)
    : resolve(process.cwd(), ".stellar-offer-ledger-poc");
  await mkdir(completedDirectory, { recursive: true });
  const runDirectory = resolve(
    completedDirectory,
    `run-${start.ledger}-${end.ledger}`,
  );
  await mkdir(runDirectory, { recursive: false });
  const ledgerBytes = Buffer.from(fetched.raw);
  const compressedLedgerBytes = gzipSync(ledgerBytes, { level: 9 });
  const snapshotStartBytes = Buffer.from(start.raw);
  const snapshotEndBytes = Buffer.from(end.raw);
  const offerEventsBytes = Buffer.from(
    JSON.stringify(replay.events.map(formatOfferEvent), null, 2),
  );
  await Promise.all([
    writeFile(resolve(runDirectory, "ledgers.json.gz"), compressedLedgerBytes, { flag: "wx" }),
    writeFile(resolve(runDirectory, "horizon-start.json"), snapshotStartBytes, { flag: "wx" }),
    writeFile(resolve(runDirectory, "horizon-end.json"), snapshotEndBytes, { flag: "wx" }),
    writeFile(resolve(runDirectory, "offer-events.json"), offerEventsBytes, { flag: "wx" }),
    writeFile(resolve(runDirectory, "replay-levels.json"), JSON.stringify({
      bids: replay.levels.bids.map(formatLevel),
      asks: replay.levels.asks.map(formatLevel),
    }, null, 2), { flag: "wx" }),
  ]);
  const checksums = {
    ledgersResponseSha256: sha256(ledgerBytes),
    ledgersCompressedSha256: sha256(compressedLedgerBytes),
    startSnapshotSha256: sha256(snapshotStartBytes),
    endSnapshotSha256: sha256(snapshotEndBytes),
    offerEventsSha256: sha256(offerEventsBytes),
    perLedgerMetadataXdrSha256: fetched.ledgers.map((ledger) => ({
      sequence: ledger.sequence,
      hash: ledger.hash,
      metadataXdrSha256: sha256(Buffer.from(ledger.metadataXdr, "base64")),
    })),
  };
  const finalManifest = {
    ...manifest,
    dataDirectory: relative(process.cwd(), runDirectory),
    checksums,
  };
  await writeFile(
    resolve(runDirectory, "manifest.json"),
    JSON.stringify(finalManifest, null, 2),
    { flag: "wx" },
  );
  return finalManifest;
}

export { DEFAULT_HORIZON_URL, DEFAULT_RPC_URL };
