#!/usr/bin/env node
/**
 * HTTP smoke test against a running Finn deployment (local or Vercel preview).
 *
 *   BASE_URL=http://localhost:3000 FINN_API_TOKEN=... npm run test:smoke
 *
 * Env:
 *   BASE_URL                         required, e.g. https://finn-git-feat-x.vercel.app
 *   FINN_API_TOKEN                   optional; without it only public/unauthorized checks run (/api/orchestrator)
 *   FINN_A2A_TOKEN                   optional; the authenticated A2A call runs only with it (A2A has its own secret)
 *   SMOKE_SKIP_LLM=1                 skip the one call that reaches Neuralake (navigation)
 *   VERCEL_AUTOMATION_BYPASS_SECRET  optional, for previews behind Deployment Protection
 *
 * No side effects on the driver's phone: navigation only RETURNS a deep link and
 * nothing touches Spotify. Exits 1 if any check fails.
 */

const BASE_URL = (process.env.BASE_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.FINN_API_TOKEN ?? "";
const A2A_TOKEN = process.env.FINN_A2A_TOKEN ?? "";
const BYPASS = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

if (!BASE_URL) {
  console.error("BASE_URL is required, e.g. BASE_URL=http://localhost:3000 npm run test:smoke");
  process.exit(2);
}

let failures = 0;
const results = [];

async function check(name, fn) {
  const started = Date.now();
  try {
    const note = await fn();
    results.push(`  ✓ ${name} (${Date.now() - started}ms)${note ? ` — ${note}` : ""}`);
  } catch (err) {
    failures++;
    results.push(`  ✗ ${name} (${Date.now() - started}ms)\n      ${err instanceof Error ? err.message : err}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function http(method, path, { token, body, raw } = {}) {
  const headers = { accept: "application/json" };
  if (BYPASS) headers["x-vercel-protection-bypass"] = BYPASS;
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (body !== undefined || raw !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    redirect: "manual",
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

const TOOLS = {
  spotify: ["list_playlists", "play_playlist", "toggle_playback"],
  waze: ["navigate_to"],
};

const messageSend = (text, method = "message/send") => ({
  jsonrpc: "2.0",
  id: "smoke-1",
  method,
  params: { message: { kind: "message", messageId: "smoke", role: "user", parts: [{ kind: "text", text }] } },
});

// --- Public ----------------------------------------------------------------
await check("GET / (PWA shell) → 200", async () => {
  const res = await http("GET", "/");
  assert(res.status === 200, `HTTP ${res.status}${res.status === 401 ? " (Vercel protection? set VERCEL_AUTOMATION_BYPASS_SECRET)" : ""}`);
});

for (const agent of ["spotify", "waze"]) {
  await check(`GET /agents/${agent}/.well-known/agent.json → valid Agent Card (no auth)`, async () => {
    const res = await http("GET", `/agents/${agent}/.well-known/agent.json`);
    assert(res.status === 200, `HTTP ${res.status}`);
    const card = res.json;
    assert(card && typeof card.name === "string" && card.name, "missing name");
    assert(typeof card.description === "string" && !/\bstub\b/i.test(card.description), `bad description: ${card.description}`);
    assert(
      typeof card.url === "string" && card.url.endsWith(`/api/agents/${agent}`) && /^https?:\/\//.test(card.url),
      `url should be absolute and end with /api/agents/${agent}: ${card.url}`,
    );
    const ids = (card.skills ?? []).map((s) => s.id).sort();
    assert(JSON.stringify(ids) === JSON.stringify(TOOLS[agent]), `skills ${JSON.stringify(ids)} ≠ ${JSON.stringify(TOOLS[agent])}`);
    return card.url;
  });
}

// --- Auth rejection ----------------------------------------------------------
for (const path of ["/api/orchestrator", "/api/agents/spotify", "/api/agents/waze"]) {
  const isA2A = path.startsWith("/api/agents/");
  // A2A is off (503) on a server without a valid FINN_A2A_TOKEN; that is also a correct rejection.
  const ok = (status) => status === 401 || (isA2A && status === 503);
  const hint = isA2A ? "expected 401, or 503 if A2A is off (FINN_A2A_TOKEN unset/invalid on the server)" : "expected 401 (503 = server auth misconfigured)";
  await check(`POST ${path} without token → ${isA2A ? "401 or 503 (A2A off)" : "401"}`, async () => {
    const res = await http("POST", path, { body: { transcript: "pausa" } });
    assert(ok(res.status), `HTTP ${res.status}; ${hint}`);
  });
  await check(`POST ${path} with a wrong token → ${isA2A ? "401 or 503 (A2A off)" : "401"}`, async () => {
    const res = await http("POST", path, { token: "definitely-wrong", body: { transcript: "pausa" } });
    assert(ok(res.status), `HTTP ${res.status}; ${hint}`);
  });
}

// --- Authorized ---------------------------------------------------------------
if (!TOKEN) {
  results.push("  - FINN_API_TOKEN not set: skipping authorized checks");
} else {
  await check("POST /api/orchestrator invalid JSON → 400", async () => {
    const res = await http("POST", "/api/orchestrator", { token: TOKEN, raw: "{oops" });
    assert(res.status === 400, `HTTP ${res.status}: ${res.text.slice(0, 200)}`);
  });

  await check("POST /api/orchestrator 'que horas são?' → 200, friendly prompt, no agent", async () => {
    const res = await http("POST", "/api/orchestrator", { token: TOKEN, body: { transcript: "que horas são?" } });
    assert(res.status === 200, `HTTP ${res.status}: ${res.text.slice(0, 200)}`);
    assert(typeof res.json?.speech === "string" && res.json.speech, "missing speech");
    assert(Array.isArray(res.json.results) && res.json.results.length === 0, "an agent was called");
    return `"${res.json.speech}"`;
  });

  if (process.env.SMOKE_SKIP_LLM === "1") {
    results.push("  - SMOKE_SKIP_LLM=1: skipping the Neuralake round-trip");
  } else {
    await check("POST /api/orchestrator navigation → 200 with a Waze deep link (model round-trip)", async () => {
      const started = Date.now();
      const res = await http("POST", "/api/orchestrator", {
        token: TOKEN,
        body: { transcript: "me leva pro aeroporto de Congonhas", contextId: `smoke-${Date.now()}` },
      });
      const ms = Date.now() - started;
      assert(res.status === 200, `HTTP ${res.status}: ${res.text.slice(0, 200)}`);
      const url = res.json?.clientActions?.find((a) => a.type === "open_url")?.url ?? "";
      assert(/^https:\/\/waze\.com\/ul\?q=[^&]*congonhas[^&]*&navigate=yes$/i.test(url), `no/odd deep link: ${url || "(none)"}; speech: ${res.json?.speech}`);
      assert(!/https?:|spotify:/i.test(res.json.speech), `technical speech: ${res.json.speech}`);
      return `${ms}ms, "${res.json.speech}"${ms > 4000 ? " ⚠ slow for a driver" : ""}`;
    });
  }
}

if (!A2A_TOKEN) {
  results.push("  - FINN_A2A_TOKEN not set: skipping authenticated A2A checks (FINN_API_TOKEN does not open /api/agents/*)");
} else {
  await check("POST /api/agents/spotify unknown method → JSON-RPC -32601", async () => {
    const res = await http("POST", "/api/agents/spotify", { token: A2A_TOKEN, body: messageSend("oi", "tasks/get") });
    assert(res.status === 200, `HTTP ${res.status}${res.status === 503 ? " (A2A off: FINN_A2A_TOKEN unset/invalid/equal to FINN_API_TOKEN on the server)" : ""}`);
    assert(res.json?.jsonrpc === "2.0" && res.json?.error?.code === -32601, `got ${res.text.slice(0, 200)}`);
  });
}

console.log(`Finn smoke @ ${BASE_URL}\n${results.join("\n")}`);
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
