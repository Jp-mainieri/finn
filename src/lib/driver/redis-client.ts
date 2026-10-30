import { Redis } from "@upstash/redis";

export const DEFAULT_REDIS_TIMEOUT_MS = 2000;

/**
 * Builds the real SDK client with safe settings:
 * - automaticDeserialization:false (raw strings; labels like "1e3" stay strings);
 * - retry with 0 retries: SDK `retry:false` still retries once, and a retried
 *   redeem EVAL could burn an invite use, so one attempt only;
 * - signal as a FUNCTION: each request gets a fresh AbortSignal.timeout and an abort
 *   throws (a non-function signal makes the SDK fake a `null` result with status 200);
 * - enableAutoPipelining:false: errors never mix commands of concurrent requests;
 * - enableTelemetry:false.
 */
export function createRedisClient(url: string, token: string, timeoutMs: number = DEFAULT_REDIS_TIMEOUT_MS): Redis {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("Invalid redis timeout");
  return new Redis({
    url,
    token,
    automaticDeserialization: false,
    retry: { retries: 0, backoff: () => 0 },
    signal: () => AbortSignal.timeout(timeoutMs),
    enableAutoPipelining: false,
    enableTelemetry: false,
  });
}
