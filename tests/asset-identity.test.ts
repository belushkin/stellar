import { describe, expect, it } from "vitest";

import type { TradingPairConfig } from "../src/config/schema.js";
import {
  AssetIdentityValidator,
  type AssetIdentityRecord,
  type AssetIdentitySource,
} from "../src/stellar/asset-identity.js";
import { openDatabase } from "../src/storage/database.js";

const issuer = "GA24LJXFG73JGARIBG2GP6V5TNUUOS6BD23KOFCW3INLDY5KPKS7GACZ";
const quoteAssetId = `USDC:${issuer}`;
const pair: TradingPairConfig = {
  base: { type: "native" },
  quote: { type: "credit", code: "USDC", issuer },
};

function validatorWithIdentity(identity: AssetIdentityRecord | undefined) {
  const database = openDatabase(":memory:");
  const source: AssetIdentitySource = {
    lookup: async () => identity,
  };
  const validator = new AssetIdentityValidator(
    database,
    {
      trustedAssetDomains: { [quoteAssetId]: "issuer.example" },
      logLevel: "silent",
    },
    source,
  );
  return { database, validator };
}

describe("AssetIdentityValidator", () => {
  it("verifies the exact Horizon asset, issuer account, and trusted home domain", async () => {
    const { database, validator } = validatorWithIdentity({
      assetCode: "USDC",
      assetIssuer: issuer,
      issuerAccountId: issuer,
      homeDomain: "Issuer.Example",
    });
    try {
      const results = await validator.validatePair(pair, 1_000);
      expect(results).toEqual([
        {
          assetId: quoteAssetId,
          status: "verified",
          homeDomain: "Issuer.Example",
          reason: null,
        },
      ]);
      expect(database.prepare(`
        SELECT validation_status, home_domain FROM assets WHERE asset_id = ?
      `).get(quoteAssetId)).toEqual({
        validation_status: "verified",
        home_domain: "Issuer.Example",
      });
    } finally {
      database.close();
    }
  });

  it("rejects issuer or domain mismatches and unrecognized assets", async () => {
    const cases: Array<{
      identity: AssetIdentityRecord | undefined;
      expectedReason: string;
    }> = [
      {
        identity: {
          assetCode: "USDC",
          assetIssuer: issuer,
          issuerAccountId: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
          homeDomain: "issuer.example",
        },
        expectedReason: "Horizon asset or issuer account does not match configured identity",
      },
      {
        identity: {
          assetCode: "USDC",
          assetIssuer: issuer,
          issuerAccountId: issuer,
          homeDomain: "untrusted.example",
        },
        expectedReason: "Issuer home domain does not match configured trusted domain",
      },
      {
        identity: undefined,
        expectedReason: "Horizon does not recognize this code and issuer",
      },
    ];

    for (const testCase of cases) {
      const { database, validator } = validatorWithIdentity(testCase.identity);
      try {
        const results = await validator.validatePair(pair, 2_000);
        expect(results[0]).toMatchObject({
          assetId: quoteAssetId,
          status: "rejected",
          reason: testCase.expectedReason,
        });
        expect(database.prepare(`
          SELECT validation_status FROM assets WHERE asset_id = ?
        `).get(quoteAssetId)).toEqual({ validation_status: "rejected" });
      } finally {
        database.close();
      }
    }
  });
});
