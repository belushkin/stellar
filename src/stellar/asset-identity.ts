import { Horizon } from "@stellar/stellar-sdk";

import type { AssetConfig, AppConfig, TradingPairConfig } from "../config/schema.js";
import { createLogger } from "../common/logger.js";
import { getAssetId, persistAssetValidation, registerTradingPair } from "../storage/market-store.js";
import type Database from "better-sqlite3";

export interface AssetIdentityRecord {
  assetCode: string;
  assetIssuer: string;
  issuerAccountId: string;
  homeDomain: string | null;
}

export interface AssetIdentitySource {
  lookup(asset: Extract<AssetConfig, { type: "credit" }>): Promise<AssetIdentityRecord | undefined>;
}

export class HorizonAssetIdentitySource implements AssetIdentitySource {
  private readonly server: InstanceType<typeof Horizon.Server>;

  constructor(horizonUrl: string) {
    this.server = new Horizon.Server(horizonUrl);
  }

  async lookup(
    asset: Extract<AssetConfig, { type: "credit" }>,
  ): Promise<AssetIdentityRecord | undefined> {
    const response = await this.server
      .assets()
      .forCode(asset.code)
      .forIssuer(asset.issuer)
      .limit(2)
      .call();
    const record = response.records.find((candidate) =>
      candidate.asset_code === asset.code && candidate.asset_issuer === asset.issuer,
    );
    if (!record) {
      return undefined;
    }

    const issuer = await this.server.loadAccount(asset.issuer);
    return {
      assetCode: record.asset_code,
      assetIssuer: record.asset_issuer,
      issuerAccountId: issuer.id,
      homeDomain: issuer.home_domain || null,
    };
  }
}

export interface AssetValidationResult {
  assetId: string;
  status: "verified" | "rejected";
  homeDomain: string | null;
  reason: string | null;
}

export class AssetIdentityValidator {
  private readonly logger: ReturnType<typeof createLogger>;

  constructor(
    private readonly database: Database.Database,
    private readonly config: Pick<AppConfig, "trustedAssetDomains" | "logLevel">,
    private readonly source: AssetIdentitySource,
  ) {
    this.logger = createLogger(config.logLevel);
  }

  async validatePair(pair: TradingPairConfig, nowMs = Date.now()): Promise<AssetValidationResult[]> {
    registerTradingPair(this.database, pair);
    const results: AssetValidationResult[] = [];
    for (const asset of [pair.base, pair.quote]) {
      if (asset.type === "native") {
        persistAssetValidation({
          database: this.database,
          asset,
          status: "verified",
          homeDomain: null,
          validatedAtMs: nowMs,
          error: null,
        });
        continue;
      }

      const expectedDomain = this.config.trustedAssetDomains[getAssetId(asset)];
      if (!expectedDomain) {
        const reason = "No trusted domain configured for credit asset";
        this.reject(asset, null, nowMs, reason);
        results.push({
          assetId: getAssetId(asset),
          status: "rejected",
          homeDomain: null,
          reason,
        });
        continue;
      }

      try {
        const identity = await this.source.lookup(asset);
        if (!identity) {
          const reason = "Horizon does not recognize this code and issuer";
          this.reject(asset, null, nowMs, reason);
          results.push({
            assetId: getAssetId(asset),
            status: "rejected",
            homeDomain: null,
            reason,
          });
          continue;
        }

        const reason = identity.assetCode !== asset.code
          || identity.assetIssuer !== asset.issuer
          || identity.issuerAccountId !== asset.issuer
          ? "Horizon asset or issuer account does not match configured identity"
          : identity.homeDomain?.toLowerCase() !== expectedDomain.toLowerCase()
            ? "Issuer home domain does not match configured trusted domain"
            : null;

        if (reason !== null) {
          this.reject(asset, identity?.homeDomain ?? null, nowMs, reason);
          results.push({
            assetId: getAssetId(asset),
            status: "rejected",
            homeDomain: identity?.homeDomain ?? null,
            reason,
          });
          continue;
        }

        persistAssetValidation({
          database: this.database,
          asset,
          status: "verified",
          homeDomain: identity.homeDomain,
          validatedAtMs: nowMs,
          error: null,
        });
        results.push({
          assetId: getAssetId(asset),
          status: "verified",
          homeDomain: identity.homeDomain,
          reason: null,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Asset identity lookup failed";
        this.reject(asset, null, nowMs, reason);
        results.push({
          assetId: getAssetId(asset),
          status: "rejected",
          homeDomain: null,
          reason,
        });
        this.logger.error({ assetId: getAssetId(asset), err: error }, "Credit asset identity validation failed");
      }
    }
    return results;
  }

  private reject(
    asset: Extract<AssetConfig, { type: "credit" }>,
    homeDomain: string | null,
    nowMs: number,
    reason: string,
  ): void {
    persistAssetValidation({
      database: this.database,
      asset,
      status: "rejected",
      homeDomain,
      validatedAtMs: nowMs,
      error: reason,
    });
  }
}
