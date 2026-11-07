import pino from "pino";

import type { AppConfig } from "../config/schema.js";

export function createLogger(level: AppConfig["logLevel"]) {
  return pino({
    level,
    base: {
      service: "stellar-dex-trading-scanner",
    },
  });
}
