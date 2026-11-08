import {
  FeeBumpTransaction,
  Networks,
  StrKey,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";

import {
  extractOfferEvents,
  type LedgerRecord,
  type OfferLifecycleEvent,
  type OfferValue,
  type ResearchPair,
} from "./offer-ledger-poc.js";

export type OfferChangeCause =
  | "execution"
  | "cancellation"
  | "modification"
  | "unresolved"
  | "not_a_reduction";

export interface OfferAttribution extends OfferLifecycleEvent {
  transactionHash: string | null;
  cause: OfferChangeCause;
  confidence: "high" | "medium" | "none";
  executedAmountStroops: string | null;
  reason: string;
}

interface OfferClaim {
  seller: string;
  offerId: string;
  assetSold: string;
  amountSold: bigint;
  assetBought: string;
  amountBought: bigint;
}

const PUBLIC_NETWORK_PASSPHRASE = Networks.PUBLIC;

function isSuccessfulOperationResult(
  result: xdr.OperationResult | null,
): result is xdr.OperationResultOpInner {
  return result?.type === "opInner";
}

function resultClaims(result: xdr.OperationResult | null): OfferClaim[] | null {
  if (!isSuccessfulOperationResult(result)) {
    return null;
  }

  const operationResult = result.tr;
  let claims: xdr.ClaimAtom[];
  switch (operationResult.type) {
    case "manageSellOffer":
      if (operationResult.value.type !== "manageSellOfferSuccess") {
        return null;
      }
      claims = operationResult.value.value.offersClaimed;
      break;
    case "manageBuyOffer":
      if (operationResult.value.type !== "manageBuyOfferSuccess") {
        return null;
      }
      claims = operationResult.value.value.offersClaimed;
      break;
    case "createPassiveSellOffer":
      if (operationResult.value.type !== "manageSellOfferSuccess") {
        return null;
      }
      claims = operationResult.value.value.offersClaimed;
      break;
    case "pathPaymentStrictReceive":
      if (operationResult.value.type !== "pathPaymentStrictReceiveSuccess") {
        return null;
      }
      claims = operationResult.value.value.offers;
      break;
    case "pathPaymentStrictSend":
      if (operationResult.value.type !== "pathPaymentStrictSendSuccess") {
        return null;
      }
      claims = operationResult.value.value.offers;
      break;
    default:
      return [];
  }

  const normalized: OfferClaim[] = [];
  for (const claim of claims) {
    if (claim.type === "claimAtomTypeLiquidityPool") {
      continue;
    }

    let seller: string;
    let offerId: string;
    let assetSold: xdr.Asset;
    let amountSold: bigint;
    let assetBought: xdr.Asset;
    let amountBought: bigint;
    if (claim.type === "claimAtomTypeOrderBook") {
      const sellerValue = claim.value.sellerId.toJSON();
      if (typeof sellerValue !== "string") {
        throw new Error("Offer claim has an invalid seller account");
      }
      seller = sellerValue;
      offerId = claim.value.offerId.toString();
      assetSold = claim.value.assetSold;
      amountSold = claim.value.amountSold;
      assetBought = claim.value.assetBought;
      amountBought = claim.value.amountBought;
    } else if (claim.type === "claimAtomTypeV0") {
      seller = StrKey.encodeEd25519PublicKey(claim.value.sellerEd25519.toBytes());
      offerId = claim.value.offerId.toString();
      assetSold = claim.value.assetSold;
      amountSold = claim.value.amountSold;
      assetBought = claim.value.assetBought;
      amountBought = claim.value.amountBought;
    } else {
      continue;
    }
    if (typeof seller !== "string") {
      throw new Error("Offer claim has an invalid seller account");
    }
    normalized.push({
      seller,
      offerId,
      assetSold: xdrAssetId(assetSold),
      amountSold,
      assetBought: xdrAssetId(assetBought),
      amountBought,
    });
  }
  return normalized;
}

function xdrAssetId(asset: xdr.Asset): string {
  const value: unknown = asset.toJSON();
  if (value === "native") {
    return "native";
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Unsupported asset in offer claim");
  }
  const record = value as Record<string, unknown>;
  const credit = record.credit_alphanum4 ?? record.credit_alphanum12;
  if (
    typeof credit !== "object"
    || credit === null
    || Array.isArray(credit)
    || typeof (credit as Record<string, unknown>).asset_code !== "string"
    || typeof (credit as Record<string, unknown>).issuer !== "string"
  ) {
    throw new Error("Malformed credit asset in offer claim");
  }
  const fields = credit as Record<string, string>;
  return `${fields.asset_code}:${fields.issuer}`;
}

function operationSource(
  operation: xdr.Operation,
  transactionSource: string,
): string {
  const source = operation.sourceAccount;
  if (!source) {
    return transactionSource;
  }
  const publicKey = source.type === "keyTypeEd25519"
    ? source.ed25519
    : source.med25519.ed25519;
  return StrKey.encodeEd25519PublicKey(publicKey.toBytes());
}

function operationOfferInput(operation: xdr.Operation): {
  offerId: string;
  amount: bigint;
} | null {
  if (operation.body.type === "manageSellOffer") {
    const input = operation.body.value;
    return { offerId: input.offerId.toString(), amount: input.amount };
  }
  if (operation.body.type === "manageBuyOffer") {
    const input = operation.body.value;
    return { offerId: input.offerId.toString(), amount: input.buyAmount };
  }
  return null;
}

function manageOfferSuccess(result: xdr.OperationResult | null): {
  effect: string;
  offer: OfferValue | null;
} | null {
  if (!isSuccessfulOperationResult(result)) {
    return null;
  }
  const operationResult = result.tr;
  let success: xdr.ManageOfferSuccessResult;
  switch (operationResult.type) {
    case "manageSellOffer":
      if (operationResult.value.type !== "manageSellOfferSuccess") {
        return null;
      }
      success = operationResult.value.value;
      break;
    case "manageBuyOffer":
      if (operationResult.value.type !== "manageBuyOfferSuccess") {
        return null;
      }
      success = operationResult.value.value;
      break;
    case "createPassiveSellOffer":
      if (operationResult.value.type !== "manageSellOfferSuccess") {
        return null;
      }
      success = operationResult.value.value;
      break;
    default:
      return null;
  }
  if (success.offer.type === "manageOfferDeleted") {
    return { effect: success.offer.type, offer: null };
  }
  const offer = success.offer.value;
  const seller = offer.sellerId.toJSON();
  if (typeof seller !== "string") {
    throw new Error("Successful offer result has an invalid seller account");
  }
  return {
    effect: success.offer.type,
    offer: {
      seller,
      offerId: offer.offerId.toString(),
      sellingAsset: xdrAssetId(offer.selling),
      buyingAsset: xdrAssetId(offer.buying),
      amountStroops: offer.amount,
      priceN: offer.price.n,
      priceD: offer.price.d,
    },
  };
}

export function classifyOfferChangeEvidence(
  event: OfferLifecycleEvent,
  transactionHash: string | null,
  transactionSource: string | null,
  operation: xdr.Operation | null,
  result: xdr.OperationResult | null,
): OfferAttribution {
  const base = {
    ...event,
    transactionHash,
    executedAmountStroops: null,
  };
  if (!event.before || event.type === "created" || event.type === "restored") {
    return {
      ...base,
      cause: "not_a_reduction",
      confidence: "none",
      reason: "The event does not reduce a previously observed offer.",
    };
  }

  const afterAmount = event.after?.amountStroops ?? 0n;
  const reduction = event.before.amountStroops - afterAmount;
  if (reduction <= 0n) {
    return {
      ...base,
      cause: "not_a_reduction",
      confidence: "none",
      reason: "The event does not reduce the offer's selling amount.",
    };
  }

  const claims = resultClaims(result);
  if (claims === null) {
    return {
      ...base,
      cause: "unresolved",
      confidence: "none",
      reason: "The operation result is missing or unsuccessful.",
    };
  }
  const matchingClaims = claims.filter(
    (claim) =>
      claim.seller === event.before!.seller
      && claim.offerId === event.before!.offerId,
  );
  if (matchingClaims.length > 0) {
    const exactClaims = matchingClaims.every(
      (claim) =>
        claim.assetSold === event.before!.sellingAsset
        && claim.assetBought === event.before!.buyingAsset
        && claim.amountSold > 0n,
    );
    const executedAmount = matchingClaims.reduce(
      (total, claim) => total + claim.amountSold,
      0n,
    );
    if (exactClaims && executedAmount === reduction) {
      return {
        ...base,
        cause: "execution",
        confidence: "high",
        executedAmountStroops: executedAmount.toString(),
        reason: "Matching ClaimOfferAtom records exactly account for the offer reduction.",
      };
    }
    return {
      ...base,
      cause: "unresolved",
      confidence: "none",
      reason: "Matching offer claims do not exactly account for the observed amount reduction.",
    };
  }

  if (!operation || !transactionSource) {
    return {
      ...base,
      cause: "unresolved",
      confidence: "none",
      reason: "The transaction envelope or operation result could not be matched by transaction hash.",
    };
  }

  const source = operationSource(operation, transactionSource);
  const input = operationOfferInput(operation);
  const success = manageOfferSuccess(result);
  if (input && success && source === event.before.seller && input.offerId === event.before.offerId) {
    if (
      input.amount === 0n
      && success.effect === "manageOfferDeleted"
      && event.type === "removed"
    ) {
      return {
        ...base,
        cause: "cancellation",
        confidence: "high",
        reason: "A zero-amount ManageSellOffer/ManageBuyOffer deleted this exact offer.",
      };
    }
    if (
      input.amount > 0n
      && success.effect === "manageOfferUpdated"
      && event.type === "updated"
      && success.offer?.seller === event.after?.seller
      && success.offer?.offerId === event.after?.offerId
      && success.offer?.amountStroops === event.after?.amountStroops
      && success.offer?.sellingAsset === event.after?.sellingAsset
      && success.offer?.buyingAsset === event.after?.buyingAsset
      && success.offer?.priceN === event.after?.priceN
      && success.offer?.priceD === event.after?.priceD
    ) {
      return {
        ...base,
        cause: "modification",
        confidence: "high",
        reason: "The successful offer operation changed this same offer and its result matches the ledger entry.",
      };
    }
  }

  if (
    operation.body.type === "accountMerge"
    && result?.type === "opInner"
    && result.tr.type === "accountMerge"
    && result.tr.value.type === "accountMergeSuccess"
  ) {
    return {
      ...base,
      cause: "unresolved",
      confidence: "none",
      reason: "A successful AccountMerge cannot account for an offer entry because offers are account subentries.",
    };
  }

  return {
    ...base,
    cause: "unresolved",
    confidence: "none",
    reason: "The offer change is not exactly explained by a matching claim, cancellation, modification, or account merge.",
  };
}

function transactionEnvelopes(closeMeta: xdr.LedgerCloseMetaV2): xdr.TransactionEnvelope[] {
  const envelopes: xdr.TransactionEnvelope[] = [];
  for (const phase of closeMeta.txSet.v1TxSet.phases) {
    if (phase.type === "parallelTxsComponent") {
      envelopes.push(...phase.parallelTxsComponent.executionStages.flat(2));
      continue;
    }
    for (const component of phase.v0Components) {
      if (component.type === "txsetCompTxsMaybeDiscountedFee") {
        envelopes.push(...component.txsMaybeDiscountedFee.txs);
      }
    }
  }
  return envelopes;
}

function transactionByHash(
  envelopes: xdr.TransactionEnvelope[],
): Map<string, xdr.TransactionEnvelope[]> {
  const byHash = new Map<string, xdr.TransactionEnvelope[]>();
  for (const envelope of envelopes) {
    const transaction = TransactionBuilder.fromXDR(
      envelope.toXDR("base64"),
      PUBLIC_NETWORK_PASSPHRASE,
    );
    const hash = Buffer.from(transaction.hash()).toString("hex");
    const candidates = byHash.get(hash) ?? [];
    candidates.push(envelope);
    byHash.set(hash, candidates);
  }
  return byHash;
}

function transactionOperations(transaction: ReturnType<typeof TransactionBuilder.fromXDR>): xdr.Operation[] {
  const parsed = transaction instanceof FeeBumpTransaction
    ? transaction.innerTransaction
    : transaction;
  const envelope = parsed.toEnvelope();
  if (envelope.type === "envelopeTypeTx") {
    return envelope.v1.tx.operations;
  }
  if (envelope.type === "envelopeTypeTxV0") {
    return envelope.v0.tx.operations;
  }
  throw new Error("Unsupported inner transaction envelope type");
}

export function classifyLedgerOfferChanges(
  ledger: LedgerRecord,
  pair: ResearchPair,
): OfferAttribution[] {
  const closeMeta = xdr.LedgerCloseMeta.fromXDR(ledger.metadataXdr, "base64");
  if (closeMeta.type !== "v2") {
    throw new Error(`Unsupported LedgerCloseMeta ${closeMeta.type}`);
  }
  if (closeMeta.value.ledgerHeader.header.ledgerSeq !== ledger.sequence) {
    throw new Error(`Metadata header sequence does not match ledger ${ledger.sequence}`);
  }

  const envelopesByHash = transactionByHash(transactionEnvelopes(closeMeta.value));
  const events = extractOfferEvents(ledger, pair);
  return events.map((event) => {
    const transactionMeta = closeMeta.value.txProcessing[event.transactionIndex];
    if (!transactionMeta || event.operationIndex < 0) {
      return classifyOfferChangeEvidence(event, null, null, null, null);
    }
    const transactionHash = transactionMeta.result.transactionHash.toString();
    const transactionResult = transactionMeta.result.result.result;
    const operationResult = transactionResult.type === "txSuccess"
      ? transactionResult.results[event.operationIndex] ?? null
      : null;
    const envelopes = envelopesByHash.get(transactionHash) ?? [];
    if (envelopes.length !== 1) {
      return classifyOfferChangeEvidence(
        event,
        transactionHash,
        null,
        null,
        operationResult,
      );
    }
    const parsed = TransactionBuilder.fromXDR(
      envelopes[0]!,
      PUBLIC_NETWORK_PASSPHRASE,
    );
    const transaction = parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : parsed;
    const operation = transactionOperations(parsed)[event.operationIndex] ?? null;
    return classifyOfferChangeEvidence(
      event,
      transactionHash,
      transaction.source,
      operation,
      operationResult,
    );
  });
}
