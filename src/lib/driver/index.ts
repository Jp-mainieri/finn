import { Redis } from "@upstash/redis";
import { MemoryDriverStore } from "./memory-store";
import { keyPrefix, type DriverStore } from "./store";
import { UpstashDriverStore } from "./upstash-store";

export * from "./store";
export * from "./invite";
export * from "./session-token";
export { MemoryDriverStore } from "./memory-store";
export { UpstashDriverStore } from "./upstash-store";

type Env = Record<string, string | undefined>;

/**
 * Selects the store. Only explicit development/test may fall back to the in-memory
 * fake. Anything else (preview, production, NODE_ENV=production without VERCEL_ENV,
 * unknown values) requires Redis credentials and throws without them. Never falls
 * back silently.
 */
export function createDriverStore(env: Env = process.env, now: () => number = Date.now): DriverStore {
  const vercelEnv = env.VERCEL_ENV ?? "development";
  const prefix = keyPrefix(vercelEnv);
  const relaxed =
    (vercelEnv === "development" || vercelEnv === "test") && !(env.VERCEL_ENV === undefined && env.NODE_ENV === "production");
  const url = env.KV_REST_API_URL;
  const token = env.KV_REST_API_TOKEN;

  if (url && token) {
    const redis = new Redis({ url, token, automaticDeserialization: false });
    return new UpstashDriverStore(redis as never, prefix, now);
  }
  if (!relaxed) throw new Error("Driver store is not configured: KV_REST_API_URL and KV_REST_API_TOKEN are required");
  return new MemoryDriverStore(prefix, now);
}

let cached: DriverStore | undefined;
export function getDriverStore(): DriverStore {
  return (cached ??= createDriverStore());
}
