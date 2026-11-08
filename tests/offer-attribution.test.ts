import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import {
  FeeBumpTransaction,
  Networks,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import {
  classifyLedgerOfferChanges,
  classifyOfferChangeEvidence,
  type OfferAttribution,
} from "../src/research/offer-attribution.js";
import type { LedgerRecord, ResearchPair } from "../src/research/offer-ledger-poc.js";

interface AttributionFixture {
  source: {
    archive: string;
    ledger: number;
    originalTransactionIndices: number[];
    transactionHashes: string[];
  };
  sequence: number;
  metadataXdr: string;
}

const fixture = JSON.parse(
  gunzipSync(
    readFileSync(new URL("./fixtures/offer-attribution-ledger.json.gz", import.meta.url)),
  ).toString(),
) as AttributionFixture;
const ledger: LedgerRecord = {
  sequence: fixture.sequence,
  hash: "fixture-ledger-hash",
  ledgerCloseTime: "2025-01-01T00:00:00.000Z",
  headerXdr: "",
  metadataXdr: fixture.metadataXdr,
};

const pairs = {
  modification: {
    base: { type: "native" },
    quote: {
      type: "credit",
      code: "SHX",
      issuer: "GDSTRSHXHGJ7ZIVRBXEYE5Q74XUVCUSEKEBR7UCHEUUEK72N7I7KJ6JH",
    },
  },
  cancellation: {
    base: { type: "native" },
    quote: {
      type: "credit",
      code: "VELO",
      issuer: "GDM4RQUQQUVSKQA7S6EM7XBZP3FCGH4Q7CL6TABQ7B2BEJ5ERARM2M5M",
    },
  },
  partialExecution: {
    base: {
      type: "credit",
      code: "USDM",
      issuer: "GDHDC4GBNPMENZAOBB4NCQ25TGZPDRK6ZGWUGSI22TVFATOLRPSUUSDM",
    },
    quote: {
      type: "credit",
      code: "USDMPOOL",
      issuer: "GDHDC4GBNPMENZAOBB4NCQ25TGZPDRK6ZGWUGSI22TVFATOLRPSUUSDM",
    },
  },
  fullExecution: {
    base: { type: "native" },
    quote: {
      type: "credit",
      code: "LMX",
      issuer: "GCJF4534PAFBOQ6R7QLVMRKUQV2AMNGEXGGDDN2ISYAIN5XPKTLUMEXO",
    },
  },
} satisfies Record<string, ResearchPair>;

function attribution(
  pair: ResearchPair,
  offerId: string,
): OfferAttribution {
  const found = classifyLedgerOfferChanges(ledger, pair)
    .find((item) => item.before?.offerId === offerId);
  if (!found) {
    throw new Error(`Missing attribution for offer ${offerId}`);
  }
  return found;
}

function operationEvidence(transactionPosition: number, operationIndex: number): {
  transactionHash: string;
  transactionSource: string;
  operation: xdr.Operation;
  result: xdr.OperationResult;
} {
  const closeMeta = xdr.LedgerCloseMeta.fromXDR(fixture.metadataXdr, "base64");
  if (closeMeta.type !== "v2") {
    throw new Error("Fixture is not LedgerCloseMetaV2");
  }
  const transactionMeta = closeMeta.value.txProcessing[transactionPosition];
  if (!transactionMeta) {
    throw new Error("Missing transaction metadata fixture");
  }
  const transactionHash = transactionMeta.result.transactionHash.toString();
  const envelopes = closeMeta.value.txSet.v1TxSet.phases.flatMap((phase) =>
    phase.type === "parallelTxsComponent"
      ? phase.parallelTxsComponent.executionStages.flat(2)
      : phase.v0Components.flatMap((component) =>
        component.type === "txsetCompTxsMaybeDiscountedFee"
          ? component.txsMaybeDiscountedFee.txs
          : [],
      ),
  );
  const envelope = envelopes.find((candidate) => {
    const parsed = TransactionBuilder.fromXDR(candidate.toXDR("base64"), Networks.PUBLIC);
    return Buffer.from(parsed.hash()).toString("hex") === transactionHash;
  });
  if (!envelope) {
    throw new Error(`Missing envelope for transaction ${transactionHash}`);
  }
  const parsed = TransactionBuilder.fromXDR(envelope, Networks.PUBLIC);
  const transaction = parsed instanceof FeeBumpTransaction
    ? parsed.innerTransaction
    : parsed;
  const transactionEnvelope = transaction.toEnvelope();
  if (transactionEnvelope.type !== "envelopeTypeTx") {
    throw new Error("Unexpected fixture transaction envelope type");
  }
  const operation = transactionEnvelope.v1.tx.operations[operationIndex];
  const result = transactionMeta.result.result.result;
  if (result.type !== "txSuccess") {
    throw new Error("Fixture transaction did not succeed");
  }
  const operationResult = result.results[operationIndex];
  if (!operation || !operationResult) {
    throw new Error("Missing operation input or result");
  }
  return {
    transactionHash,
    transactionSource: transaction.source,
    operation,
    result: operationResult,
  };
}

describe("Stellar offer lifecycle attribution research", () => {
  it("classifies an exact partial fill from real offer claim metadata", () => {
    const item = attribution(pairs.partialExecution, "1709991932");

    expect(item.cause).toBe("execution");
    expect(item.confidence).toBe("high");
    expect(item.executedAmountStroops).toBe("64641");
    expect(item.before!.amountStroops - item.after!.amountStroops).toBe(64641n);
    expect(item.transactionHash)
      .toBe("26e41ce9307f9c01612a45f7cdefd718e84fd7fdded4a9d55220c0285d819be7");
  });

  it("classifies a fully consumed offer only when its matching claim covers the amount", () => {
    const item = attribution(pairs.fullExecution, "1865115512");

    expect(item.cause).toBe("execution");
    expect(item.executedAmountStroops).toBe("1720000000");
    expect(item.after).toBeNull();
  });

  it("identifies a zero-amount ManageBuyOffer cancellation from real metadata", () => {
    const item = attribution(pairs.cancellation, "1865115517");

    expect(item.cause).toBe("cancellation");
    expect(item.confidence).toBe("high");
    expect(item.executedAmountStroops).toBeNull();
    expect(item.transactionHash)
      .toBe("529ad822bd1d9f1a7ed62afbf52daf9bc18cde385ec528a26f4b240436041026");
  });

  it("classifies a no-claim amount decrease as modification, not execution", () => {
    const item = attribution(pairs.modification, "1865085863");

    expect(item.cause).toBe("modification");
    expect(item.confidence).toBe("high");
    expect(item.before!.amountStroops - item.after!.amountStroops).toBe(180n);
    expect(item.executedAmountStroops).toBeNull();
  });

  it("fails closed when a matching claim does not account for the full reduction", () => {
    const item = attribution(pairs.partialExecution, "1709991932");
    const evidence = operationEvidence(2, 0);
    const claimOnly = classifyOfferChangeEvidence(
      item,
      evidence.transactionHash,
      null,
      null,
      evidence.result,
    );
    const inconsistent = classifyOfferChangeEvidence({
      ...item,
      before: {
        ...item.before!,
        amountStroops: item.before!.amountStroops + 1n,
      },
    }, evidence.transactionHash, evidence.transactionSource, evidence.operation, evidence.result);

    expect(claimOnly.cause).toBe("execution");
    expect(inconsistent.cause).toBe("unresolved");
    expect(inconsistent.executedAmountStroops).toBeNull();
  });
});
