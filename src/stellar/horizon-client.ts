import { Horizon } from "@stellar/stellar-sdk";
import { z } from "zod";

import type { AppConfig } from "../config/schema.js";
import { createLogger } from "../common/logger.js";
import { withRetry } from "../common/retry.js";

const HorizonRootSchema = z.object({
  horizon_version: z.string(),
  core_version: z.string(),
  history_latest_ledger: z.number().int().nonnegative(),
  history_latest_ledger_closed_at: z.string(),
  network_passphrase: z.string(),
});

export interface HorizonGateway {
  root(): Promise<unknown>;
}

export interface HorizonStatus {
  horizonVersion: string;
  coreVersion: string;
  latestLedger: number;
  latestLedgerClosedAt: string;
  networkPassphrase: string;
  checkedAt: string;
}

export function isRetryableHorizonError(error: unknown): boolean {
  if (error instanceof TypeError) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  if (error.name === "NetworkError" || error.name === "TimeoutError") {
    return true;
  }

  if (typeof error !== "object" || error === null || !("response" in error)) {
    return false;
  }

  const response = error.response;
  if (typeof response !== "object" || response === null || !("status" in response)) {
    return false;
  }

  const status = response.status;
  return typeof status === "number" && (status === 429 || status >= 500);
}

export class HorizonClient {
  private readonly gateway: HorizonGateway;
  private readonly logger: ReturnType<typeof createLogger>;

  constructor(
    private readonly config: AppConfig,
    gateway?: HorizonGateway,
  ) {
    this.gateway = gateway ?? new Horizon.Server(config.horizonUrl);
    this.logger = createLogger(config.logLevel);
  }

  async checkConnection(): Promise<HorizonStatus> {
    const root = await withRetry(
      () => this.gateway.root(),
      {
        maxRetries: this.config.maxRetries,
        baseDelayMs: this.config.retryBaseDelayMs,
        maxDelayMs: this.config.retryMaxDelayMs,
        onRetry: (error, retryNumber, delayMs) => {
          this.logger.warn(
            { err: error, retryNumber, delayMs },
            "Retrying Horizon request",
          );
        },
      },
      isRetryableHorizonError,
    );
    const parsed = HorizonRootSchema.parse(root);

    return {
      horizonVersion: parsed.horizon_version,
      coreVersion: parsed.core_version,
      latestLedger: parsed.history_latest_ledger,
      latestLedgerClosedAt: parsed.history_latest_ledger_closed_at,
      networkPassphrase: parsed.network_passphrase,
      checkedAt: new Date().toISOString(),
    };
  }
}
