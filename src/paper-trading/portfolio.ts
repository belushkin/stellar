import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

import { Big } from "../common/decimal.js";
import type { MakerPortfolioState } from "../strategies/passive-maker.js";
import type { TradingPairConfig } from "../config/schema.js";
import { getPairId } from "../order-book/normalize.js";
import { getAssetId } from "../storage/market-store.js";

export interface PaperBalance {
  assetId: string;
  available: string;
  reserved: string;
}

export function getPaperBalance(
  database: Database.Database,
  portfolioId: string,
  assetId: string,
): PaperBalance {
  const row = database.prepare(`
    SELECT available, reserved FROM paper_balances
    WHERE portfolio_id = ? AND asset_id = ?
  `).get(portfolioId, assetId) as { available: string; reserved: string } | undefined;
  return {
    assetId,
    available: row?.available ?? "0",
    reserved: row?.reserved ?? "0",
  };
}

export function initializePaperPortfolio(input: {
  database: Database.Database;
  portfolioId: string;
  initialBalances: Record<string, string>;
  nowMs?: number;
}): boolean {
  const nowMs = input.nowMs ?? Date.now();
  return input.database.transaction(() => {
    const existing = input.database.prepare(`
      SELECT 1 FROM paper_portfolios WHERE portfolio_id = ?
    `).get(input.portfolioId);
    if (existing) {
      return false;
    }

    input.database.prepare(`
      INSERT INTO paper_portfolios (portfolio_id, created_at_ms) VALUES (?, ?)
    `).run(input.portfolioId, nowMs);
    for (const [assetId, amount] of Object.entries(input.initialBalances)) {
      ensureAsset(input.database, assetId);
      const initial = new Big(amount);
      if (!initial.gte(0)) {
        throw new Error(`Initial paper balance for ${assetId} must be nonnegative`);
      }
      input.database.prepare(`
        INSERT INTO paper_balances (portfolio_id, asset_id, available, reserved)
        VALUES (?, ?, ?, '0')
      `).run(input.portfolioId, assetId, initial.toString());
      if (initial.gt(0)) {
        input.database.prepare(`
          INSERT INTO paper_ledger_entries (
            entry_id, idempotency_key, portfolio_id, asset_id, bucket, amount,
            entry_type, reference_type, reference_id, created_at_ms
          ) VALUES (?, ?, ?, ?, 'available', ?, 'opening_balance', 'portfolio', ?, ?)
        `).run(
          randomUUID(),
          `opening:${input.portfolioId}:${assetId}`,
          input.portfolioId,
          assetId,
          initial.toString(),
          input.portfolioId,
          nowMs,
        );
      }
    }
    return true;
  }).immediate();
}

export function applyBalanceDelta(input: {
  database: Database.Database;
  portfolioId: string;
  assetId: string;
  bucket: "available" | "reserved";
  delta: Big;
  entryType: string;
  referenceType: string;
  referenceId: string;
  idempotencyKey: string;
  nowMs: number;
}): boolean {
  const { database } = input;
  const exists = database.prepare(`
    SELECT 1 FROM paper_ledger_entries WHERE idempotency_key = ?
  `).get(input.idempotencyKey);
  if (exists) {
    return false;
  }

  database.prepare(`
    INSERT OR IGNORE INTO paper_balances (portfolio_id, asset_id, available, reserved)
    VALUES (?, ?, '0', '0')
  `).run(input.portfolioId, input.assetId);
  const current = getPaperBalance(database, input.portfolioId, input.assetId);
  const currentAmount = new Big(current[input.bucket]);
  const updatedAmount = currentAmount.plus(input.delta);
  if (updatedAmount.lt(0)) {
    throw new Error(`Insufficient ${input.bucket} balance for ${input.assetId}`);
  }

  database.prepare(`
    INSERT INTO paper_ledger_entries (
      entry_id, idempotency_key, portfolio_id, asset_id, bucket, amount,
      entry_type, reference_type, reference_id, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    input.idempotencyKey,
    input.portfolioId,
    input.assetId,
    input.bucket,
    input.delta.toString(),
    input.entryType,
    input.referenceType,
    input.referenceId,
    input.nowMs,
  );
  database.prepare(`
    UPDATE paper_balances SET ${input.bucket} = ?
    WHERE portfolio_id = ? AND asset_id = ?
  `).run(updatedAmount.toString(), input.portfolioId, input.assetId);
  return true;
}

export function reconcilePaperBalances(
  database: Database.Database,
  portfolioId: string,
): void {
  database.transaction(() => {
    const entries = database.prepare(`
      SELECT asset_id, bucket, amount
      FROM paper_ledger_entries WHERE portfolio_id = ?
      ORDER BY rowid
    `).all(portfolioId) as {
      asset_id: string;
      bucket: "available" | "reserved";
      amount: string;
    }[];
    const totals = new Map<string, { available: Big; reserved: Big }>();
    for (const entry of entries) {
      const total = totals.get(entry.asset_id) ?? {
        available: new Big(0),
        reserved: new Big(0),
      };
      total[entry.bucket] = total[entry.bucket].plus(entry.amount);
      totals.set(entry.asset_id, total);
    }

    database.prepare("DELETE FROM paper_balances WHERE portfolio_id = ?").run(portfolioId);
    const insert = database.prepare(`
      INSERT INTO paper_balances (portfolio_id, asset_id, available, reserved)
      VALUES (?, ?, ?, ?)
    `);
    for (const [assetId, total] of totals) {
      if (total.available.lt(0) || total.reserved.lt(0)) {
        throw new Error(`Paper ledger is inconsistent for ${assetId}`);
      }
      insert.run(
        portfolioId,
        assetId,
        total.available.toString(),
        total.reserved.toString(),
      );
    }
  }).immediate();
}

export function getMakerPortfolioState(
  database: Database.Database,
  portfolioId: string,
  pair: TradingPairConfig,
): MakerPortfolioState {
  const baseAssetId = getAssetId(pair.base);
  const quoteAssetId = getAssetId(pair.quote);
  const base = getPaperBalance(database, portfolioId, baseAssetId);
  const quote = getPaperBalance(database, portfolioId, quoteAssetId);
  return {
    pairId: getPairId(pair),
    baseInventory: new Big(base.available).plus(base.reserved).toString(),
    availableBase: base.available,
    availableQuote: quote.available,
  };
}

function ensureAsset(database: Database.Database, assetId: string): void {
  if (assetId === "native") {
    database.prepare(`
      INSERT OR IGNORE INTO assets (asset_id, asset_type) VALUES ('native', 'native')
    `).run();
    return;
  }
  const match = /^([A-Za-z0-9]{1,12}):(G[A-Z2-7]{55})$/.exec(assetId);
  if (!match) {
    throw new Error(`Invalid initial paper balance asset ID: ${assetId}`);
  }
  database.prepare(`
    INSERT OR IGNORE INTO assets (asset_id, asset_type, code, issuer)
    VALUES (?, 'credit', ?, ?)
  `).run(assetId, match[1], match[2]);
}
