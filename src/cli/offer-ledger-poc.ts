import { runOfferLedgerPoc } from "../research/offer-ledger-poc.js";

const ledgerSpan = Number(process.argv[2] ?? "12");
if (!Number.isInteger(ledgerSpan) || ledgerSpan < 2 || ledgerSpan > 20) {
  throw new Error("Usage: node --import tsx src/cli/offer-ledger-poc.ts [ledger-span:2..20]");
}

runOfferLedgerPoc({ ledgerSpan })
  .then((report) => {
    console.log(JSON.stringify(report, null, 2));
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
