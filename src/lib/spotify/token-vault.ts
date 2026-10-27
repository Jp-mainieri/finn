/**
 * Per-driver Spotify refresh token custody: encrypt, store, read, delete.
 * The server is the only holder; the token never goes back to a client.
 * Redis failures are DriverStoreUnavailableError (generic); a blob that does not decrypt reads as
 * "not connected". Nothing here logs.
 */
import { getDriverStore, isValidDriverId, keyPrefix, keys, type DriverStore } from "../driver";
import { decryptToken, encryptToken, getTokenEncKey } from "./token-crypto";

type Env = Record<string, string | undefined>;
export interface VaultDeps {
  store?: DriverStore;
  env?: Env;
}

/** Thrown when FINN_TOKEN_ENC_KEY is missing or invalid: tokens are neither written nor read. */
export class TokenVaultDisabledError extends Error {
  constructor() {
    super("Spotify token vault disabled");
    this.name = "TokenVaultDisabledError";
  }
}

/** `finn:<env>:`; the same rule as the driver store (VERCEL_ENV, default development). */
function prefixOf(env: Env): string {
  return keyPrefix(env.VERCEL_ENV ?? "development");
}

/** Cipher AAD: exactly the Redis key of the blob (`finn:<env>:spotify:<driverId>`). */
export function tokenAad(driverId: string, env: Env = process.env): string {
  return keys.spotifyToken(prefixOf(env), driverId);
}

export function isTokenVaultEnabled(env: Env = process.env): boolean {
  return getTokenEncKey(env) !== null;
}

function keyOrThrow(env: Env): Buffer {
  const key = getTokenEncKey(env);
  if (!key) throw new TokenVaultDisabledError();
  return key;
}

/** Encrypts and stores the refresh token under `driverId` (the id of a SERVER record, never of the client). */
export async function saveSpotifyRefreshToken(driverId: string, refreshToken: string, deps: VaultDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  if (!isValidDriverId(driverId) || typeof refreshToken !== "string" || !refreshToken) throw new Error("Invalid token input");
  const key = keyOrThrow(env);
  const blob = encryptToken(refreshToken, key, tokenAad(driverId, env));
  await (deps.store ?? getDriverStore()).setSpotifyBlob(driverId, blob);
}

/** The plaintext refresh token, or null when not connected or undecryptable. Throws when the vault is disabled. */
export async function loadSpotifyRefreshToken(driverId: string, deps: VaultDeps = {}): Promise<string | null> {
  const env = deps.env ?? process.env;
  if (!isValidDriverId(driverId)) return null;
  const key = keyOrThrow(env); // no key: nothing is read from Redis
  const blob = await (deps.store ?? getDriverStore()).getSpotifyBlob(driverId);
  if (blob === null) return null;
  return decryptToken(blob, key, tokenAad(driverId, env));
}

export async function deleteSpotifyRefreshToken(driverId: string, deps: VaultDeps = {}): Promise<void> {
  await (deps.store ?? getDriverStore()).deleteSpotifyBlob(driverId);
}
