export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  onRetry?: (error: unknown, retryNumber: number, delayMs: number) => void;
}

export interface RetryDependencies {
  sleep: (delayMs: number) => Promise<void>;
  random: () => number;
}

const defaultDependencies: RetryDependencies = {
  sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  random: Math.random,
};

export async function withRetry<T>(
  operation: () => Promise<T>,
  policy: RetryPolicy,
  isRetryable: (error: unknown) => boolean,
  dependencies: RetryDependencies = defaultDependencies,
): Promise<T> {
  for (let retryNumber = 0; ; retryNumber += 1) {
    try {
      return await operation();
    } catch (error) {
      if (retryNumber >= policy.maxRetries || !isRetryable(error)) {
        throw error;
      }

      const delayCeiling = Math.min(
        policy.baseDelayMs * 2 ** retryNumber,
        policy.maxDelayMs,
      );
      const randomValue = Math.min(Math.max(dependencies.random(), 0), 0.999999);
      const delayMs = Math.floor(randomValue * delayCeiling);

      policy.onRetry?.(error, retryNumber + 1, delayMs);
      await dependencies.sleep(delayMs);
    }
  }
}
