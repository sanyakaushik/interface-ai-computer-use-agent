import { describe, expect, it, vi } from "vitest";
import { withRetry } from "../src/agent/retry.js";

function errWithStatus(status: number) {
  const e = new Error(`http ${status}`);
  (e as { status?: number }).status = status;
  return e;
}

describe("withRetry", () => {
  it("returns the result on first success without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { baseDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a transient (429) error and eventually succeeds", async () => {
    const fn = vi.fn().mockRejectedValueOnce(errWithStatus(429)).mockResolvedValue("ok");
    const result = await withRetry(fn, { baseDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxAttempts and throws the last error", async () => {
    const fn = vi.fn().mockRejectedValue(errWithStatus(503));
    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 })).rejects.toThrow("http 503");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-transient error (e.g. 400 bad request)", async () => {
    const fn = vi.fn().mockRejectedValue(errWithStatus(400));
    await expect(withRetry(fn, { baseDelayMs: 1 })).rejects.toThrow("http 400");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("calls onRetry with attempt number and delay before each retry", async () => {
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValueOnce(errWithStatus(500)).mockResolvedValue("ok");
    await withRetry(fn, { baseDelayMs: 1, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]![0]).toBe(1);
  });
});
