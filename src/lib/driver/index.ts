import type { Redis } from "@upstash/redis";
import { createRedisClient } from "./redis-client";
import { MemoryDriverStore } from "./memory-store";
import { keyPrefix, type DriverStore } from "./store";
import { UpstashDriverStore } from "./upstash-store";

export * from "./store";
export * from "./invite";
export * from "./session-token";
export { MemoryDriverStore } from "./memory-store";
export { createRedisClient } from "./redis-client";
export { UpstashDriverStore, hashToRecord } from "./upstash-store";

type Env = Record<string, string | undefined>;

/**
 * Resolves where per-driver data lives. Only explicit development/test may fall back to
 * memory (`redis: null`). Anything else (preview, production, NODE_ENV=production without
 * VERCEL_ENV, unknown values) requires Redis credentials and throws without them.
 * Never falls back silently. The prefix `finn:<env>:` is always applied by the callers.
 */
export function resolveDriverBackend(env: Env = process.env): { prefix: string; redis: Redis | null } {
  const vercelEnv = env.VERCEL_ENV ?? "development";
  const prefix = keyPrefix(vercelEnv);
  // NODE_ENV=production is never relaxed, whatever VERCEL_ENV says.
  const relaxed = (vercelEnv === "development" || vercelEnv === "test") && env.NODE_ENV !== "production";
  const url = env.KV_REST_API_URL;
  const token = env.KV_REST_API_TOKEN;

  if (url && token) return { prefix, redis: createRedisClient(url, token) };
  if (!relaxed) throw new Error("Driver store is not configured: KV_REST_API_URL and KV_REST_API_TOKEN are required");
  return { prefix, redis: null };
}

export function createDriverStore(env: Env = process.env, now: () => number = Date.now): DriverStore {
  const { prefix, redis } = resolveDriverBackend(env);
  return redis ? new UpstashDriverStore(redis, prefix, now) : new MemoryDriverStore(prefix, now);
}

let cached: DriverStore | undefined;
export function getDriverStore(): DriverStore {
  return (cached ??= createDriverStore());
}
