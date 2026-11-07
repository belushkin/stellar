import { describe, expect, it, vi } from "vitest";

import { withRetry } from "../src/common/retry.js";

describe("withRetry", () => {
  const policy = {
    maxRetries: 2,
    baseDelayMs: 100,
    maxDelayMs: 150,
  };

  it("retries transient errors with capped exponential jitter", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValue("ok");
    const sleep = vi.fn().mockResolvedValue(undefined);
    const onRetry = vi.fn();

    await expect(withRetry(
      operation,
      { ...policy, onRetry },
      (error) => error instanceof TypeError,
      { sleep, random: () => 0.5 },
    )).resolves.toBe("ok");

    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([50, 75]);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("does not retry permanent errors", async () => {
    const error = new Error("bad request");
    const operation = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn();

    await expect(withRetry(
      operation,
      policy,
      () => false,
      { sleep, random: () => 0 },
    )).rejects.toBe(error);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("rethrows the last transient error when retries are exhausted", async () => {
    const error = new TypeError("network unavailable");
    const operation = vi.fn().mockRejectedValue(error);

    await expect(withRetry(
      operation,
      policy,
      () => true,
      { sleep: vi.fn().mockResolvedValue(undefined), random: () => 0 },
    )).rejects.toBe(error);

    expect(operation).toHaveBeenCalledTimes(3);
  });
});
