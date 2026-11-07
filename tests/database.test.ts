import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/storage/database.js";

describe("openDatabase", () => {
  it("initializes SQLite pragmas and records the initial migration", () => {
    const database = openDatabase(":memory:");

    try {
      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(database.pragma("busy_timeout", { simple: true })).toBe(5000);
      expect(database.prepare("SELECT version FROM schema_migrations").all())
        .toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
      expect(database.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'paper_orders'
      `).get()).toEqual({ name: "paper_orders" });
      expect(database.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'paper_depth_allocations'
      `).get()).toEqual({ name: "paper_depth_allocations" });
    } finally {
      database.close();
    }
  });
});
