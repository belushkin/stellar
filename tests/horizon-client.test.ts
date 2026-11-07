import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config/schema.js";
import { HorizonClient, type HorizonGateway } from "../src/stellar/horizon-client.js";

const validRoot = {
  horizon_version: "test-horizon",
  core_version: "test-core",
  history_latest_ledger: 123,
  history_latest_ledger_closed_at: "2026-01-01T00:00:00Z",
  network_passphrase: "Test SDF Network ; September 2015",
};

describe("HorizonClient", () => {
  it("reads and validates the Horizon root without credentials", async () => {
    const gateway: HorizonGateway = {
      root: vi.fn().mockResolvedValue(validRoot),
    };
    const client = new HorizonClient(loadConfig({}), gateway);

    const status = await client.checkConnection();

    expect(status.horizonVersion).toBe("test-horizon");
    expect(status.latestLedger).toBe(123);
    expect(status.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(gateway.root).toHaveBeenCalledOnce();
  });

  it("retries rate-limit errors and then returns the connection status", async () => {
    const rateLimitError = Object.assign(new Error("rate limited"), {
      response: { status: 429 },
    });
    const gateway: HorizonGateway = {
      root: vi.fn()
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValue(validRoot),
    };
    const client = new HorizonClient(
      loadConfig({ STELLAR_RETRY_BASE_DELAY_MS: "1", STELLAR_RETRY_MAX_DELAY_MS: "1" }),
      gateway,
    );

    await expect(client.checkConnection()).resolves.toMatchObject({
      horizonVersion: "test-horizon",
      latestLedger: 123,
    });
    expect(gateway.root).toHaveBeenCalledTimes(2);
  });

  it("surfaces malformed Horizon responses", async () => {
    const gateway: HorizonGateway = {
      root: vi.fn().mockResolvedValue({}),
    };
    const client = new HorizonClient(loadConfig({}), gateway);

    await expect(client.checkConnection()).rejects.toThrow();
  });
});
