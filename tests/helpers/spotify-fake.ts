/**
 * Fake Spotify Web API behind `globalThis.fetch`, following the endpoints fixed
 * in docs/ARCHITECTURE.md ("Detalhes de integração"). Every request is recorded
 * so tests can assert what the agent sent. Non-Spotify URLs are recorded as
 * `external` and either rejected (default) or passed through to the real fetch
 * (live evals, which talk to the real Neuralake).
 */
import { vi } from "vitest";
import { mark } from "./timeline";

export const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
export const SPOTIFY_API = "https://api.spotify.com/v1";

export type Endpoint =
  | "token" // POST accounts.spotify.com/api/token
  | "playlists" // GET  /v1/me/playlists
  | "play" // PUT  /v1/me/player/play
  | "pause" // PUT  /v1/me/player/pause
  | "next" // POST /v1/me/player/next
  | "spotify-other" // any other Spotify URL/method (always a bug)
  | "external"; // anything that isn't Spotify

export interface RecordedCall {
  endpoint: Endpoint;
  method: string;
  url: URL;
  headers: Headers;
  /** Raw request body ("" / undefined when none). */
  body: string | undefined;
  /** `body` parsed as JSON when possible. */
  json: unknown;
  startedAt: number;
  endedAt?: number;
}

export type Reply =
  | { status: number; body?: unknown; delayMs?: number }
  | { networkError: true }
  | { hang: true };

export interface Playlist {
  id: string;
  name: string;
}

const mixes = (from: number, to: number): Playlist[] =>
  Array.from({ length: to - from + 1 }, (_, i) => {
    const n = String(from + i).padStart(2, "0");
    return { id: `pl_mix_${n}`, name: `Mix Diário ${n}` };
  });

/**
 * 55 playlists → two pages at limit=50; a couple of named ones live on page 2.
 * "Rock Nacional"/"Rock Clássico" make "rock" ambiguous; "Punk" must not match "funk".
 */
export const PLAYLISTS: Playlist[] = [
  { id: "pl_rock", name: "Rock Nacional" },
  { id: "pl_rock_classico", name: "Rock Clássico" },
  { id: "pl_pagode", name: "Pagode do Fim de Semana" },
  { id: "pl_foco", name: "Foco Total" },
  { id: "pl_sertanejo", name: "Sertanejo Raiz" },
  { id: "pl_mpb", name: "MPB Acústico" },
  { id: "pl_punk", name: "Punk" },
  ...mixes(1, 43),
  { id: "pl_viagem", name: "Viagem de Carro" },
  { id: "pl_lofi", name: "Lo-fi para Estudar" },
  ...mixes(44, 46),
];

export const playlistNamed = (name: string): Playlist => {
  const p = PLAYLISTS.find((x) => x.name === name);
  if (!p) throw new Error(`fixture has no playlist "${name}"`);
  return p;
};

export const spotifyError = (status: number, message: string, reason?: string): Reply => ({
  status,
  body: { error: { status, message, ...(reason ? { reason } : {}) } },
});

export const EXPIRED_TOKEN = spotifyError(401, "The access token expired");
export const NO_ACTIVE_DEVICE = spotifyError(
  404,
  "Player command failed: No active device found",
  "NO_ACTIVE_DEVICE",
);
export const SERVER_ERROR = spotifyError(500, "Internal server error");
export const RATE_LIMITED = spotifyError(429, "API rate limit exceeded");
export const PREMIUM_REQUIRED = spotifyError(403, "Player command failed: Premium required", "PREMIUM_REQUIRED");
export const INVALID_GRANT: Reply = {
  status: 400,
  body: { error: "invalid_grant", error_description: "Refresh token revoked" },
};

export interface FakeSpotifyCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

function classify(method: string, url: URL): Endpoint {
  if (url.origin === "https://accounts.spotify.com") {
    return method === "POST" && url.pathname === "/api/token" ? "token" : "spotify-other";
  }
  if (url.origin !== "https://api.spotify.com") return "external";
  const route = `${method} ${url.pathname.replace(/\/+$/, "")}`;
  switch (route) {
    case "GET /v1/me/playlists":
      return "playlists";
    case "PUT /v1/me/player/play":
      return "play";
    case "PUT /v1/me/player/pause":
      return "pause";
    case "POST /v1/me/player/next":
      return "next";
    default:
      return "spotify-other";
  }
}

async function readBody(input: RequestInfo | URL, init?: RequestInit): Promise<string | undefined> {
  const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
  if (raw == null) return undefined;
  if (typeof raw === "string") return raw;
  if (raw instanceof URLSearchParams) return raw.toString();
  return new Response(raw as BodyInit).text();
}

function wait(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}

export class FakeSpotify {
  readonly calls: RecordedCall[] = [];
  playlists: Playlist[] = PLAYLISTS;
  /** Latency per endpoint (ms), applied to default replies. */
  readonly latency: Partial<Record<Endpoint, number>> = {};
  private readonly queued: Partial<Record<Endpoint, Reply[]>> = {};
  private readonly issued = new Set<string>();
  private tokenSeq = 0;

  constructor(
    private readonly creds: FakeSpotifyCredentials,
    private readonly realFetch?: typeof fetch,
  ) {}

  /** Next replies for `endpoint`, consumed FIFO before falling back to the happy path. */
  enqueue(endpoint: Endpoint, ...replies: Reply[]): this {
    (this.queued[endpoint] ??= []).push(...replies);
    return this;
  }

  callsTo(endpoint: Endpoint): RecordedCall[] {
    return this.calls.filter((c) => c.endpoint === endpoint);
  }

  /** Calls to spotify.com hosts (token + API). */
  get spotifyCalls(): RecordedCall[] {
    return this.calls.filter((c) => c.endpoint !== "external");
  }

  get issuedTokens(): string[] {
    return [...this.issued];
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const endpoint = classify(method, url);

    if (endpoint === "external" && this.realFetch) return this.realFetch(input, init);

    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((v, k) => headers.set(k, v));
    const body = await readBody(input, init);
    let json: unknown;
    try {
      json = body ? JSON.parse(body) : undefined;
    } catch {
      json = undefined;
    }
    const call: RecordedCall = { endpoint, method, url, headers, body, json, startedAt: performance.now() };
    this.calls.push(call);
    mark(`spotify:${endpoint}:start`);

    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    try {
      const reply = this.queued[endpoint]?.shift() ?? this.defaultReply(call);
      if ("networkError" in reply) throw new TypeError("fetch failed (fake network error)");
      if ("hang" in reply) await wait(2 ** 31 - 1, signal);
      if ("status" in reply) {
        const delay = reply.delayMs ?? this.latency[endpoint] ?? 0;
        if (delay) await wait(delay, signal);
        return reply.status === 204 || reply.body === undefined
          ? new Response(null, { status: reply.status })
          : Response.json(reply.body, { status: reply.status });
      }
      throw new Error("unreachable");
    } finally {
      call.endedAt = performance.now();
      mark(`spotify:${endpoint}:end`);
    }
  };

  private defaultReply(call: RecordedCall): Reply {
    switch (call.endpoint) {
      case "token":
        return this.tokenReply(call);
      case "playlists":
      case "play":
      case "pause":
      case "next": {
        const auth = call.headers.get("authorization") ?? "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        if (!this.issued.has(token)) return spotifyError(401, "Invalid access token");
        return call.endpoint === "playlists" ? this.playlistsPage(call.url) : { status: 204 };
      }
      case "spotify-other":
        return spotifyError(405, `fake Spotify: unexpected ${call.method} ${call.url.pathname}`);
      case "external":
        return { status: 599, body: { error: `fake fetch: unexpected external call to ${call.url}` } };
    }
  }

  /** Accepts Basic client auth (per spec) or client_id/client_secret in the form body. */
  private tokenReply(call: RecordedCall): Reply {
    const form = new URLSearchParams(call.body ?? "");
    const basic = `Basic ${Buffer.from(`${this.creds.clientId}:${this.creds.clientSecret}`).toString("base64")}`;
    const clientOk =
      call.headers.get("authorization") === basic ||
      (form.get("client_id") === this.creds.clientId && form.get("client_secret") === this.creds.clientSecret);
    if (!clientOk) return { status: 400, body: { error: "invalid_client" } };
    if (form.get("grant_type") !== "refresh_token" || form.get("refresh_token") !== this.creds.refreshToken) {
      return INVALID_GRANT;
    }
    const token = `fake-access-${++this.tokenSeq}`;
    this.issued.add(token);
    return {
      status: 200,
      body: {
        access_token: token,
        token_type: "Bearer",
        expires_in: 3600,
        scope: "user-modify-playback-state playlist-read-private playlist-read-collaborative",
      },
    };
  }

  private playlistsPage(url: URL): Reply {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 50);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const total = this.playlists.length;
    const items = this.playlists.slice(offset, offset + limit).map((p) => ({
      id: p.id,
      name: p.name,
      uri: `spotify:playlist:${p.id}`,
      href: `${SPOTIFY_API}/playlists/${p.id}`,
      public: false,
      collaborative: false,
      owner: { id: "driver", display_name: "Motorista" },
      tracks: { href: `${SPOTIFY_API}/playlists/${p.id}/tracks`, total: 20 },
    }));
    const page = (o: number) => `${SPOTIFY_API}/me/playlists?offset=${o}&limit=${limit}`;
    return {
      status: 200,
      body: {
        href: page(offset),
        items,
        limit,
        offset,
        total,
        next: offset + limit < total ? page(offset + limit) : null,
        previous: offset > 0 ? page(Math.max(0, offset - limit)) : null,
      },
    };
  }
}

/** Installs a fresh fake as `globalThis.fetch` (undo with `vi.unstubAllGlobals()`). */
export function installFakeSpotify(
  creds: FakeSpotifyCredentials,
  opts: { passthroughExternal?: boolean } = {},
): FakeSpotify {
  const fake = new FakeSpotify(creds, opts.passthroughExternal ? globalThis.fetch : undefined);
  vi.stubGlobal("fetch", fake.fetch);
  return fake;
}
