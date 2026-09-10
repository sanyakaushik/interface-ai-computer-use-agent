// Retries a transient failure from the model API (rate limits, overload, network blips) with
// exponential backoff + jitter. Does not retry non-transient errors (bad request, auth failure,
// tool-schema errors) — those indicate a real bug and should surface immediately rather than be
// masked by three slow retries.
const RETRYABLE_STATUS_CODES = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 1000;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === maxAttempts) throw err;
      const delayMs = baseDelayMs * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5);
      opts.onRetry?.(attempt, err, delayMs);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (typeof status === "number") return RETRYABLE_STATUS_CODES.has(status);
  // Network-level errors (no HTTP status) — connection reset, timeout, DNS blip — are worth one retry.
  const code = (err as { code?: string })?.code;
  return code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND";
}
