import { z } from "zod";

const AssetConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("native"),
  }),
  z.object({
    type: z.literal("credit"),
    code: z.string().regex(/^[A-Za-z0-9]{1,12}$/),
    issuer: z.string().regex(/^G[A-Z2-7]{55}$/),
  }),
]);

function assetId(asset: AssetConfig): string {
  return asset.type === "native" ? "native" : `${asset.code}:${asset.issuer}`;
}

const TradingPairConfigSchema = z.object({
  base: AssetConfigSchema,
  quote: AssetConfigSchema,
}).superRefine((pair, context) => {
  if (assetId(pair.base) === assetId(pair.quote)) {
    context.addIssue({
      code: "custom",
      path: ["quote"],
      message: "Base and quote assets must be different",
    });
  }
});

const NonNegativeDecimalSchema = z.string().regex(/^\d+(?:\.\d+)?$/);
const AssetIdSchema = z.string().regex(
  /^(?:native|[A-Za-z0-9]{1,12}:G[A-Z2-7]{55})$/,
);
const TrustedAssetDomainsSchema = z.record(
  AssetIdSchema,
  z.string().regex(/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/),
);
const PositiveDecimalSchema = NonNegativeDecimalSchema.refine(
  (value) => /[1-9]/.test(value),
  { message: "Must be greater than zero" },
);
const PaperMaxDailyLossSchema = z.record(AssetIdSchema, PositiveDecimalSchema);

export const AppConfigSchema = z.object({
  horizonUrl: z
    .string()
    .url()
    .refine((value) => new URL(value).protocol === "https:", {
      message: "Horizon URL must use HTTPS",
    }),
  databasePath: z.string().min(1),
  maxRetries: z.number().int().min(0).max(10),
  retryBaseDelayMs: z.number().int().positive(),
  retryMaxDelayMs: z.number().int().positive(),
  maxOrderBookAgeMs: z.number().int().positive(),
  minimumSpreadPercent: NonNegativeDecimalSchema,
  minimumLiquidityBase: NonNegativeDecimalSchema,
  maximumSlippagePercent: NonNegativeDecimalSchema,
  minimumExpectedNetProfitQuote: NonNegativeDecimalSchema,
  maximumMakerOrderBase: PositiveDecimalSchema,
  maximumInventoryBase: PositiveDecimalSchema,
  makerInventoryRiskBps: z.number().finite().nonnegative(),
  makerMinimumEvidenceSamples: z.number().int().positive(),
  makerEvidenceMaxAgeMs: z.number().int().positive(),
  makerReplacementsPerOrder: z.number().int().min(0).max(10),
  feeConversionProbeXlm: PositiveDecimalSchema,
  feeDataRefreshMs: z.number().int().positive(),
  feeDataMaxAgeMs: z.number().int().positive(),
  feeConversionMaxDeviationBps: z.number().finite().nonnegative().max(10_000),
  assetValidationMaxAgeMs: z.number().int().positive(),
  trustedAssetDomains: TrustedAssetDomainsSchema,
  paperInitialBalances: z.record(AssetIdSchema, NonNegativeDecimalSchema),
  paperPortfolioId: z.string().min(1).max(64),
  paperEmergencyStop: z.boolean(),
  paperMaxDailyLossByQuote: PaperMaxDailyLossSchema,
  pairs: z.array(TradingPairConfigSchema).max(4, {
    message: "At most 4 pairs can be streamed through the public Horizon endpoint",
  }),
  logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]),
}).superRefine((config, context) => {
  if (config.retryMaxDelayMs < config.retryBaseDelayMs) {
    context.addIssue({
      code: "custom",
      path: ["retryMaxDelayMs"],
      message: "Retry maximum delay must be at least the base delay",
    });
  }
  if (config.feeDataMaxAgeMs < config.feeDataRefreshMs) {
    context.addIssue({
      code: "custom",
      path: ["feeDataMaxAgeMs"],
      message: "Fee data maximum age must be at least the refresh interval",
    });
  }

  for (const pair of config.pairs) {
    for (const asset of [pair.base, pair.quote]) {
      if (asset.type === "credit" && !config.trustedAssetDomains[assetId(asset)]) {
        context.addIssue({
          code: "custom",
          path: ["trustedAssetDomains", assetId(asset)],
          message: "Every configured credit asset requires an expected trusted domain",
        });
      }
    }
    if (!config.paperMaxDailyLossByQuote[assetId(pair.quote)]) {
      context.addIssue({
        code: "custom",
        path: ["paperMaxDailyLossByQuote", assetId(pair.quote)],
        message: "Every configured quote asset requires a positive daily loss limit",
      });
    }
  }

  const pairIds = new Set<string>();
  config.pairs.forEach((pair, index) => {
    const pairId = `${assetId(pair.base)}/${assetId(pair.quote)}`;
    if (pairIds.has(pairId)) {
      context.addIssue({
        code: "custom",
        path: ["pairs", index],
        message: `Duplicate trading pair: ${pairId}`,
      });
    }
    pairIds.add(pairId);
  });
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type AssetConfig = z.infer<typeof AssetConfigSchema>;
export type TradingPairConfig = z.infer<typeof TradingPairConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  let pairs: unknown = [];
  let trustedAssetDomains: unknown = {};
  let paperInitialBalances: unknown = {};
  let paperMaxDailyLossByQuote: unknown = {};
  if (env.STELLAR_PAIRS !== undefined) {
    try {
      pairs = JSON.parse(env.STELLAR_PAIRS);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error("STELLAR_PAIRS must contain valid JSON", { cause: error });
      }
      throw error;
    }
  }
  if (env.STELLAR_TRUSTED_ASSET_DOMAINS !== undefined) {
    try {
      trustedAssetDomains = JSON.parse(env.STELLAR_TRUSTED_ASSET_DOMAINS);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error("STELLAR_TRUSTED_ASSET_DOMAINS must contain valid JSON", { cause: error });
      }
      throw error;
    }
  }
  if (env.STELLAR_PAPER_INITIAL_BALANCES !== undefined) {
    try {
      paperInitialBalances = JSON.parse(env.STELLAR_PAPER_INITIAL_BALANCES);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error("STELLAR_PAPER_INITIAL_BALANCES must contain valid JSON", { cause: error });
      }
      throw error;
    }
  }
  if (env.STELLAR_PAPER_MAX_DAILY_LOSS_BY_QUOTE !== undefined) {
    try {
      paperMaxDailyLossByQuote = JSON.parse(env.STELLAR_PAPER_MAX_DAILY_LOSS_BY_QUOTE);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(
          "STELLAR_PAPER_MAX_DAILY_LOSS_BY_QUOTE must contain valid JSON",
          { cause: error },
        );
      }
      throw error;
    }
  }

  const config = {
    horizonUrl: env.STELLAR_HORIZON_URL ?? "https://horizon.stellar.org",
    databasePath: env.STELLAR_DATABASE_PATH ?? "./data/stellar-scanner.sqlite",
    maxRetries: Number(env.STELLAR_MAX_RETRIES ?? 3),
    retryBaseDelayMs: Number(env.STELLAR_RETRY_BASE_DELAY_MS ?? 250),
    retryMaxDelayMs: Number(env.STELLAR_RETRY_MAX_DELAY_MS ?? 5000),
    maxOrderBookAgeMs: Number(env.STELLAR_MAX_ORDER_BOOK_AGE_MS ?? 15000),
    minimumSpreadPercent: env.STELLAR_MIN_SPREAD_PERCENT ?? "0.1",
    minimumLiquidityBase: env.STELLAR_MIN_LIQUIDITY_BASE ?? "1",
    maximumSlippagePercent: env.STELLAR_MAX_SLIPPAGE_PERCENT ?? "0.5",
    minimumExpectedNetProfitQuote: env.STELLAR_MIN_EXPECTED_NET_PROFIT_QUOTE ?? "0.01",
    maximumMakerOrderBase: env.STELLAR_MAX_MAKER_ORDER_BASE ?? "1",
    maximumInventoryBase: env.STELLAR_MAX_INVENTORY_BASE ?? "5",
    makerInventoryRiskBps: Number(env.STELLAR_MAKER_INVENTORY_RISK_BPS ?? 25),
    makerMinimumEvidenceSamples: Number(env.STELLAR_MAKER_MIN_EVIDENCE_SAMPLES ?? 100),
    makerEvidenceMaxAgeMs: Number(env.STELLAR_MAKER_EVIDENCE_MAX_AGE_MS ?? 3600000),
    makerReplacementsPerOrder: Number(env.STELLAR_MAKER_REPLACEMENTS_PER_ORDER ?? 0),
    feeConversionProbeXlm: env.STELLAR_FEE_CONVERSION_PROBE_XLM ?? "1",
    feeDataRefreshMs: Number(env.STELLAR_FEE_DATA_REFRESH_MS ?? 30000),
    feeDataMaxAgeMs: Number(env.STELLAR_FEE_DATA_MAX_AGE_MS ?? 120000),
    feeConversionMaxDeviationBps: Number(
      env.STELLAR_FEE_CONVERSION_MAX_DEVIATION_BPS ?? 200,
    ),
    assetValidationMaxAgeMs: Number(env.STELLAR_ASSET_VALIDATION_MAX_AGE_MS ?? 86_400_000),
    trustedAssetDomains,
    paperInitialBalances,
    paperPortfolioId: env.STELLAR_PAPER_PORTFOLIO_ID ?? "default",
    paperEmergencyStop: z.enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true")
      .parse(env.STELLAR_PAPER_EMERGENCY_STOP),
    paperMaxDailyLossByQuote,
    pairs,
    logLevel: env.LOG_LEVEL ?? "info",
  };

  return AppConfigSchema.parse(config);
}
