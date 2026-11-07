import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

import type { TradingPairConfig, AssetConfig } from "../config/schema.js";
import { getPairId } from "../order-book/normalize.js";
import type { OrderBookSnapshot } from "../order-book/types.js";
import type { PassiveMakerSide, MakerModelEvidence } from "../strategies/passive-maker.js";

export function getAssetId(asset: AssetConfig): string {
  return asset.type === "native" ? "native" : `${asset.code}:${asset.issuer}`;
}

function registerAsset(database: Database.Database, asset: AssetConfig): void {
  database.prepare(`
    INSERT OR IGNORE INTO assets (asset_id, asset_type, code, issuer)
    VALUES (?, ?, ?, ?)
  `).run(
    getAssetId(asset),
    asset.type,
    asset.type === "credit" ? asset.code : null,
    asset.type === "credit" ? asset.issuer : null,
  );
}

export function registerTradingPair(
  database: Database.Database,
  pair: TradingPairConfig,
): string {
  registerAsset(database, pair.base);
  registerAsset(database, pair.quote);
  const pairId = getPairId(pair);
  database.prepare(`
    INSERT INTO trading_pairs (pair_id, base_asset_id, quote_asset_id)
    VALUES (?, ?, ?)
    ON CONFLICT(pair_id) DO NOTHING
  `).run(pairId, getAssetId(pair.base), getAssetId(pair.quote));
  return pairId;
}

export function persistAssetValidation(input: {
  database: Database.Database;
  asset: AssetConfig;
  status: "unverified" | "verified" | "rejected";
  homeDomain: string | null;
  validatedAtMs: number;
  error: string | null;
}): void {
  registerAsset(input.database, input.asset);
  input.database.prepare(`
    UPDATE assets
    SET home_domain = ?, validation_status = ?, validated_at_ms = ?, validation_error = ?
    WHERE asset_id = ?
  `).run(
    input.homeDomain,
    input.status,
    input.validatedAtMs,
    input.error,
    getAssetId(input.asset),
  );
}

export function recordMarketSnapshot(
  database: Database.Database,
  book: OrderBookSnapshot,
  validationReasons: string[],
  source = "horizon_orderbook",
): number {
  const serialized = JSON.stringify(book);
  const contentHash = createHash("sha256").update(serialized).digest("hex");
  return database.transaction(() => {
    const sequence = database.prepare(`
      SELECT COALESCE(MAX(received_sequence), 0) + 1 AS nextSequence
      FROM market_snapshots WHERE pair_id = ?
    `).get(book.pairId) as { nextSequence: number };
    const result = database.prepare(`
      INSERT INTO market_snapshots (
        pair_id, received_at_ms, latest_ledger, snapshot_json, content_hash,
        integrity_status, validation_reasons_json, source, source_timestamp_ms,
        received_sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      book.pairId,
      book.receivedAtMs,
      book.latestLedger,
      serialized,
      contentHash,
      validationReasons.length === 0 ? "valid" : "rejected",
      JSON.stringify(validationReasons),
      source,
      null,
      sequence.nextSequence,
    );
    return Number(result.lastInsertRowid);
  })();
}

export function recordStrategyDecision(input: {
  database: Database.Database;
  pairId: string;
  snapshotId: number;
  side: PassiveMakerSide;
  status: "positive" | "rejected" | "insufficient_data";
  reasons: string[];
  evidence: MakerModelEvidence | undefined;
  feeEstimate: unknown;
  createdAtMs: number;
  strategyId?: string;
  modelVersion?: string;
}): string {
  const decisionId = randomUUID();
  input.database.prepare(`
    INSERT INTO strategy_decisions (
      decision_id, pair_id, snapshot_id, side, status, reasons_json,
      evidence_json, fee_estimate_json, created_at_ms, strategy_id,
      model_version, observed_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    decisionId,
    input.pairId,
    input.snapshotId,
    input.side,
    input.status,
    JSON.stringify(input.reasons),
    input.evidence === undefined ? null : JSON.stringify(input.evidence),
    JSON.stringify(input.feeEstimate),
    input.createdAtMs,
    input.strategyId ?? "passive_maker",
    input.modelVersion ?? "passive_maker_v1",
    input.createdAtMs,
  );
  return decisionId;
}
