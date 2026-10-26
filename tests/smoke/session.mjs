#!/usr/bin/env node
/**
 * Owner's manual smoke against a PREVIEW deployment: redeems an invite for real, so it
 * is also the first time the redeem Lua runs on a real Redis.
 *
 *   npm run smoke:session -- <baseUrl> <inviteCode>
 *
 * Env (optional): VERCEL_AUTOMATION_BYPASS_SECRET for previews behind Deployment Protection.
 * Steps: POST /api/session, GET /api/session, POST /api/orchestrator ("pausa a música").
 * Prints only PASSOU/FALHOU and the HTTP status per step. Never prints the token, the code
 * or any response body. The orchestrator step may act on the driver's Spotify.
 */
const [baseArg, inviteCode] = process.argv.slice(2);
if (!baseArg || !inviteCode) {
  console.error("Uso: npm run smoke:session -- <baseUrl> <inviteCode>");
  process.exit(2);
}
const base = baseArg.replace(/\/+$/, "");
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

async function call(method, path, { token, body } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (bypass) headers["x-vercel-protection-bypass"] = bypass;
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* not JSON */
    }
    return { status: res.status, json };
  } catch {
    return { status: 0, json: null };
  }
}

let failed = false;
const report = (name, ok, status) => {
  if (!ok) failed = true;
  console.log(`${ok ? "PASSOU" : "FALHOU"}  ${name}  (HTTP ${status === 0 ? "sem resposta" : status})`);
};

const redeem = await call("POST", "/api/session", { body: { inviteCode } });
const token = redeem.json?.token;
const driverId = redeem.json?.driverId;
report("POST /api/session (resgata o convite)", redeem.status === 200 && typeof token === "string" && typeof driverId === "string", redeem.status);

if (typeof token === "string") {
  const who = await call("GET", "/api/session", { token });
  report("GET /api/session (token vale)", who.status === 200 && who.json?.driverId === driverId, who.status);

  const orch = await call("POST", "/api/orchestrator", { token, body: { transcript: "pausa a música" } });
  report("POST /api/orchestrator (com o token)", orch.status === 200, orch.status);

  const bad = await call("GET", "/api/session", { token: `${token.slice(0, -2)}xx` });
  report("GET /api/session com token adulterado é recusado", bad.status === 401, bad.status);
} else {
  console.log("Passos seguintes não executados: sem token.");
}

process.exit(failed ? 1 : 0);
