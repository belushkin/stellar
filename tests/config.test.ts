import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/schema.js";

describe("loadConfig", () => {
  it("loads safe public-Horizon defaults without credential settings", () => {
    const config = loadConfig({});

    expect(config.horizonUrl).toBe("https://horizon.stellar.org");
    expect(config.maxRetries).toBe(3);
    expect(config.pairs).toEqual([]);
    expect(config).not.toHaveProperty("secretKey");
  });

  it("rejects non-HTTPS Horizon URLs", () => {
    expect(() => loadConfig({ STELLAR_HORIZON_URL: "http://example.test" }))
      .toThrow("Horizon URL must use HTTPS");
  });

  it("rejects malformed pair configuration", () => {
    expect(() => loadConfig({ STELLAR_PAIRS: '[{"base":{"type":"native"}}]' }))
      .toThrow();
  });

  it("rejects identical assets in a pair and excessive public streams", () => {
    expect(() => loadConfig({
      STELLAR_PAIRS: '[{"base":{"type":"native"},"quote":{"type":"native"}}]',
    })).toThrow("Base and quote assets must be different");

    const nativeToCredit = {
      base: { type: "native" },
      quote: {
        type: "credit",
        code: "USDC",
        issuer: "GA24LJXFG73JGARIBG2GP6V5TNUUOS6BD23KOFCW3INLDY5KPKS7GACZ",
      },
    };
    expect(() => loadConfig({
      STELLAR_PAIRS: JSON.stringify([
        nativeToCredit,
        nativeToCredit,
        nativeToCredit,
        nativeToCredit,
        nativeToCredit,
      ]),
    })).toThrow("At most 4 pairs");
  });

  it("reports invalid pair JSON explicitly", () => {
    expect(() => loadConfig({ STELLAR_PAIRS: "{" }))
      .toThrow("STELLAR_PAIRS must contain valid JSON");
  });

  it("requires a trusted domain for every configured credit asset", () => {
    const pair = {
      base: { type: "native" },
      quote: {
        type: "credit",
        code: "USDC",
        issuer: "GA24LJXFG73JGARIBG2GP6V5TNUUOS6BD23KOFCW3INLDY5KPKS7GACZ",
      },
    };

    expect(() => loadConfig({ STELLAR_PAIRS: JSON.stringify([pair]) }))
      .toThrow("Every configured credit asset requires an expected trusted domain");

    const config = loadConfig({
      STELLAR_PAIRS: JSON.stringify([pair]),
      STELLAR_TRUSTED_ASSET_DOMAINS: JSON.stringify({
        "USDC:GA24LJXFG73JGARIBG2GP6V5TNUUOS6BD23KOFCW3INLDY5KPKS7GACZ": "issuer.example",
      }),
      STELLAR_PAPER_MAX_DAILY_LOSS_BY_QUOTE: '{"USDC:GA24LJXFG73JGARIBG2GP6V5TNUUOS6BD23KOFCW3INLDY5KPKS7GACZ":"25"}',
    });
    expect(config.trustedAssetDomains).toEqual({
      "USDC:GA24LJXFG73JGARIBG2GP6V5TNUUOS6BD23KOFCW3INLDY5KPKS7GACZ": "issuer.example",
    });
    expect(config.paperMaxDailyLossByQuote).toEqual({
      "USDC:GA24LJXFG73JGARIBG2GP6V5TNUUOS6BD23KOFCW3INLDY5KPKS7GACZ": "25",
    });
  });

  it("loads explicit paper balances and rejects malformed balance assets", () => {
    const config = loadConfig({
      STELLAR_PAPER_INITIAL_BALANCES: '{"native":"100","USDC:GA24LJXFG73JGARIBG2GP6V5TNUUOS6BD23KOFCW3INLDY5KPKS7GACZ":"250"}',
    });
    expect(config.paperInitialBalances).toEqual({
      native: "100",
      "USDC:GA24LJXFG73JGARIBG2GP6V5TNUUOS6BD23KOFCW3INLDY5KPKS7GACZ": "250",
    });
    expect(() => loadConfig({
      STELLAR_PAPER_INITIAL_BALANCES: '{"not-an-asset":"10"}',
    })).toThrow();
  });

  it("parses the emergency stop and requires daily loss limits for quote assets", () => {
    expect(loadConfig({ STELLAR_PAPER_EMERGENCY_STOP: "true" }).paperEmergencyStop).toBe(true);
    expect(() => loadConfig({ STELLAR_PAPER_EMERGENCY_STOP: "yes" })).toThrow();
    expect(() => loadConfig({
      STELLAR_PAIRS: JSON.stringify([{
        base: { type: "native" },
        quote: {
          type: "credit",
          code: "USDC",
          issuer: "GA24LJXFG73JGARIBG2GP6V5TNUUOS6BD23KOFCW3INLDY5KPKS7GACZ",
        },
      }]),
      STELLAR_TRUSTED_ASSET_DOMAINS: JSON.stringify({
        "USDC:GA24LJXFG73JGARIBG2GP6V5TNUUOS6BD23KOFCW3INLDY5KPKS7GACZ": "issuer.example",
      }),
    })).toThrow("Every configured quote asset requires a positive daily loss limit");
  });
});
