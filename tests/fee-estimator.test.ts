import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config/schema.js";
import {
  NetworkFeeEstimator,
  roundTripOperationCount,
  type FeeDataSource,
  type FeeRateSnapshot,
  type XlmQuoteConversion,
} from "../src/market-data/fee-estimator.js";

const quote = {
  type: "credit",
  code: "USDC",
  issuer: "GA24LJXFG73JGARIBG2GP6V5TNUUOS6BD23KOFCW3INLDY5KPKS7GACZ",
} as const;

const feeRate: FeeRateSnapshot = {
  operationFeeStroops: "1000",
  lastLedger: "456",
  fetchedAtMs: 1_000,
};

const conversion: XlmQuoteConversion = {
  quotePerXlm: "2",
  path: ["XLM", "USDC:issuer"],
  fetchedAtMs: 1_000,
};

function makeSource(overrides: Partial<FeeDataSource> = {}): FeeDataSource {
  return {
    fetchFeeRate: vi.fn().mockResolvedValue(feeRate),
    fetchXlmToQuoteConversion: vi.fn().mockResolvedValue(conversion),
    ...overrides,
  };
}

describe("roundTripOperationCount", () => {
  it("includes placement, configured replacements, and cancellation for both orders", () => {
    expect(roundTripOperationCount(0)).toBe(4);
    expect(roundTripOperationCount(2)).toBe(8);
    expect(() => roundTripOperationCount(-1)).toThrow(
      "Replacement count must be a nonnegative integer",
    );
  });
});

describe("NetworkFeeEstimator", () => {
  it("uses live fee inputs, round-trip operation count, and quote conversion", async () => {
    const source = makeSource();
    const estimator = new NetworkFeeEstimator(source, loadConfig({}));

    const estimate = await estimator.estimateRoundTrip(quote, 1, 1_000);

    expect(estimate.complete).toBe(true);
    expect(estimate.operationCount).toBe(6);
    expect(estimate.nature).toBe("simulated_estimate");
    expect(estimate.feeRateMethod).toBe(
      "max_last_ledger_base_fee_and_fee_charged_p95",
    );
    expect(estimate.quoteAssetId).toBe(
      "USDC:GA24LJXFG73JGARIBG2GP6V5TNUUOS6BD23KOFCW3INLDY5KPKS7GACZ",
    );
    expect(estimate.operationFeeStroops).toBe("1000");
    expect(estimate.totalFeeStroops).toBe("6000");
    expect(estimate.networkFeeXlm).toBe("0.0006");
    expect(estimate.networkFeeQuote).toBe("0.0012");
    expect(estimate.feeStatsLastLedger).toBe("456");
    expect(estimate.conversionPath).toEqual(["XLM", "USDC:issuer"]);
  });

  it("keeps XLM fee information but marks quote net profit incomplete without conversion", async () => {
    const source = makeSource({
      fetchXlmToQuoteConversion: vi.fn().mockRejectedValue(
        new Error("no conversion route"),
      ),
    });
    const estimator = new NetworkFeeEstimator(source, loadConfig({}));

    const estimate = await estimator.estimateRoundTrip(quote, 1, 1_000);

    expect(estimate.complete).toBe(false);
    expect(estimate.reason).toBe("fee_conversion_unavailable");
    expect(estimate.networkFeeXlm).toBe("0.0006");
    expect(estimate.networkFeeQuote).toBeNull();
    expect(estimate.error).toBe("no conversion route");
  });

  it("does not substitute zero when fee statistics are unavailable", async () => {
    const source = makeSource({
      fetchFeeRate: vi.fn().mockRejectedValue(new Error("Horizon unavailable")),
    });
    const estimator = new NetworkFeeEstimator(source, loadConfig({}));

    const estimate = await estimator.estimateRoundTrip(quote, 0, 1_000);

    expect(estimate.complete).toBe(false);
    expect(estimate.reason).toBe("fee_stats_unavailable");
    expect(estimate.operationFeeStroops).toBeNull();
    expect(estimate.networkFeeQuote).toBeNull();
  });

  it("rejects stale network fee data", async () => {
    const source = makeSource({
      fetchFeeRate: vi.fn().mockResolvedValue({ ...feeRate, fetchedAtMs: 0 }),
    });
    const config = loadConfig({
      STELLAR_FEE_DATA_REFRESH_MS: "100",
      STELLAR_FEE_DATA_MAX_AGE_MS: "500",
    });
    const estimator = new NetworkFeeEstimator(source, config);

    const estimate = await estimator.estimateRoundTrip(quote, 0, 1_000);

    expect(estimate.complete).toBe(false);
    expect(estimate.reason).toBe("fee_stats_stale");
    expect(estimate.feeStatsLastLedger).toBe("456");
    expect(estimate.networkFeeQuote).toBeNull();
  });

  it("caches fee and conversion data within their refresh interval", async () => {
    const source = makeSource();
    const estimator = new NetworkFeeEstimator(source, loadConfig({}));

    await estimator.estimateRoundTrip(quote, 0, 1_000);
    await estimator.estimateRoundTrip(quote, 0, 1_001);

    expect(source.fetchFeeRate).toHaveBeenCalledOnce();
    expect(source.fetchXlmToQuoteConversion).toHaveBeenCalledOnce();
  });

  it("measures freshness after asynchronous fee and conversion requests complete", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const source = makeSource({
        fetchFeeRate: vi.fn(async () => {
          vi.setSystemTime(1_100);
          return { ...feeRate, fetchedAtMs: Date.now() };
        }),
        fetchXlmToQuoteConversion: vi.fn(async () => {
          vi.setSystemTime(1_200);
          return { ...conversion, fetchedAtMs: Date.now() };
        }),
      });
      const estimator = new NetworkFeeEstimator(source, loadConfig({}));

      const estimate = await estimator.estimateRoundTrip(quote, 0);

      expect(estimate.complete).toBe(true);
      expect(estimate.feeStatsFetchedAtMs).toBe(1_100);
      expect(estimate.conversionFetchedAtMs).toBe(1_200);
    } finally {
      vi.useRealTimers();
    }
  });
});
