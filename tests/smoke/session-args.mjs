// Argument and target validation for tests/smoke/session.mjs (kept apart so it is unit-testable).

/** Hosts that count as NON-production: localhost/loopback and *.vercel.app (previews). Everything else is treated as production. */
export const PREVIEW_HOST_SUFFIX = ".vercel.app";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function parseSmokeArgs(argv) {
  const positional = [];
  const flags = { allowProduction: false, withOrchestrator: false };
  for (const a of argv) {
    if (a === "--allow-production") flags.allowProduction = true;
    else if (a === "--with-orchestrator") flags.withOrchestrator = true;
    else if (a.startsWith("--")) return { error: `Opção desconhecida: ${a.split("=")[0]}` };
    else positional.push(a);
  }
  if (positional.length !== 2) return { error: "Uso: npm run -s smoke:session -- <baseUrl> <inviteCode> [--with-orchestrator] [--allow-production]" };
  return { baseUrl: positional[0], inviteCode: positional[1], ...flags };
}

/** Returns an error message (Portuguese) when the target must be refused, otherwise null. */
export function checkTarget(baseUrl, { allowProduction = false } = {}) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return "baseUrl inválida.";
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    return "Recusado: use https:// (http só para localhost/127.0.0.1).";
  }
  const preview = url.hostname.endsWith(PREVIEW_HOST_SUFFIX);
  if (!local && !preview && !allowProduction) {
    return `Recusado: ${url.hostname} não termina em ${PREVIEW_HOST_SUFFIX} nem é localhost, então conta como produção. Passe --allow-production se for isso mesmo.`;
  }
  return null;
}
