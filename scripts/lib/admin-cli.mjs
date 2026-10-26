// Owner CLI core (invites and drivers). Run through scripts/driver-admin.mjs.
// Relative imports only (no "@/" alias). Credentials come from process.env: the owner
// runs `node --env-file=<file> ...`; this code never reads .env* files itself.
// Never prints the invite pepper, the session secret, the Redis URL/token or any session token.
import {
  DriverStoreUnavailableError,
  UpstashDriverStore,
  createRedisClient,
  isValidDriverId,
  keyPrefix,
} from "../../src/lib/driver/index.ts";

export const ENVS = ["production", "preview", "development"];
const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_USES = 1;
export const DEFAULT_DAYS = 7;

const USAGE = `Uso: npm run <comando> -- --env production|preview|development [--confirm-production] [opções]

  invite:create --label <txt> [--max-uses N] [--days N]   imprime o código UMA vez (padrão: ${DEFAULT_MAX_USES} uso, ${DEFAULT_DAYS} dias)
  invite:revoke <código>
  driver:list
  driver:revoke <driverId> [--yes]
  driver:rotate <driverId> [--yes]

--env é obrigatório e não tem padrão (define o prefixo finn:<env>:). Para production, --confirm-production também.
Credenciais vêm do ambiente do processo: node --env-file=<arquivo> (KV_REST_API_URL, KV_REST_API_TOKEN, FINN_INVITE_PEPPER).`;

class UsageError extends Error {}

const VALUE_FLAGS = new Set(["env", "label", "max-uses", "days"]);
const BOOL_FLAGS = new Set(["confirm-production", "yes"]);

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (BOOL_FLAGS.has(name)) flags[name] = true;
      else if (VALUE_FLAGS.has(name)) {
        const v = rest[++i];
        if (v === undefined || v.startsWith("--")) throw new UsageError(`A opção --${name} precisa de um valor.`);
        flags[name] = v;
      } else throw new UsageError(`Opção desconhecida: --${name}`);
    } else positional.push(a);
  }
  return { command, flags, positional };
}

function parsePositiveInt(raw, name, fallback) {
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/.test(raw) || Number(raw) < 1) throw new UsageError(`--${name} precisa ser um inteiro positivo.`);
  return Number(raw);
}

function defaultConfirm(question) {
  return import("node:readline/promises").then(async ({ createInterface }) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = await rl.question(`${question} [s/N] `);
      return /^(s|sim|y|yes)$/i.test(answer.trim());
    } finally {
      rl.close();
    }
  });
}

function defaultCreateStore(env, vars) {
  const url = vars.KV_REST_API_URL;
  const token = vars.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new UsageError("Credenciais do Redis ausentes (KV_REST_API_URL e KV_REST_API_TOKEN). Use node --env-file=<arquivo>.");
  }
  return new UpstashDriverStore(createRedisClient(url, token), keyPrefix(env));
}

const SAFE_MESSAGE = /^(Invalid (label|maxUses|expiresAt|invite pepper|key prefix)|Invite pepper must differ|Missing required environment variable: [A-Z0-9_]+$)/;

function when(ms) {
  return new Date(ms).toISOString();
}

/**
 * @param {string[]} argv  e.g. ["invite:create", "--env", "preview", "--label", "Carro"]
 * @param {{ env?: Record<string,string|undefined>, out?: (s:string)=>void, err?: (s:string)=>void,
 *           createStore?: (env:string, vars:object)=>object, confirm?: (q:string)=>Promise<boolean>,
 *           now?: ()=>number }} [deps]
 * @returns {Promise<number>} exit code
 */
export async function run(argv, deps = {}) {
  const vars = deps.env ?? process.env;
  const out = deps.out ?? ((s) => process.stdout.write(`${s}\n`));
  const err = deps.err ?? ((s) => process.stderr.write(`${s}\n`));
  const confirm = deps.confirm ?? defaultConfirm;
  const createStore = deps.createStore ?? defaultCreateStore;
  const now = deps.now ?? Date.now;

  try {
    const { command, flags, positional } = parseArgs(argv);
    const commands = ["invite:create", "invite:revoke", "driver:list", "driver:revoke", "driver:rotate"];
    if (!commands.includes(command)) throw new UsageError(command ? `Comando desconhecido: ${command}` : "Comando ausente.");

    if (!flags.env) throw new UsageError("Recusado: --env é obrigatório (production, preview ou development). Não há padrão.");
    if (!ENVS.includes(flags.env)) throw new UsageError("Recusado: --env precisa ser production, preview ou development.");
    if (flags.env === "production" && !flags["confirm-production"]) {
      throw new UsageError("Recusado: em production é preciso passar também --confirm-production.");
    }

    const store = createStore(flags.env, vars);

    if (command === "invite:create") {
      if (!flags.label) throw new UsageError("--label é obrigatório.");
      const maxUses = parsePositiveInt(flags["max-uses"], "max-uses", DEFAULT_MAX_USES);
      const days = parsePositiveInt(flags.days, "days", DEFAULT_DAYS);
      const { code } = await store.createInvite({ label: flags.label, maxUses, expiresAt: now() + days * DAY_MS });
      out(code); // the only output; shown once, never stored in clear
      return 0;
    }

    if (command === "invite:revoke") {
      if (positional.length !== 1) throw new UsageError("Informe o código: invite:revoke <código>");
      await store.revokeInvite(positional[0]);
      out("Pedido de revogação enviado. O store é idempotente e não diz se o código existia: confira o código digitado.");
      return 0;
    }

    if (command === "driver:list") {
      const drivers = await store.listDrivers();
      if (drivers.length === 0) out("Nenhum motorista.");
      for (const d of drivers) out(`${d.driverId}\t${d.label}\t${d.status}\t${when(d.createdAt)}`);
      return 0;
    }

    // driver:revoke / driver:rotate
    if (positional.length !== 1) throw new UsageError(`Informe o driverId: ${command} <driverId>`);
    const id = positional[0];
    const driver = isValidDriverId(id) ? await store.getDriver(id) : null;
    if (!driver) {
      err("Motorista não encontrado neste ambiente. Confira o driverId (use driver:list). Nada foi alterado.");
      return 1;
    }
    out(`Alvo: "${driver.label}" (${driver.driverId}), status ${driver.status}, criado em ${when(driver.createdAt)}`);
    if (command === "driver:rotate" && driver.status !== "active") {
      err("Este motorista já está revogado: rotacionar sessões não tem efeito. Nada foi alterado.");
      return 1;
    }
    if (command === "driver:revoke" && driver.status === "revoked") {
      out("Já estava revogado. Nada a fazer.");
      return 0;
    }
    const verb = command === "driver:revoke" ? "REVOGAR este motorista (o token dele deixa de valer)" : "ROTACIONAR as sessões deste motorista (todos os tokens antigos deixam de valer)";
    if (!flags.yes && !(await confirm(`${verb} em ${flags.env}?`))) {
      err("Cancelado. Nada foi alterado.");
      return 1;
    }
    if (command === "driver:revoke") await store.revokeDriver(driver.driverId);
    else await store.rotateSessions(driver.driverId);
    out(command === "driver:revoke" ? "Motorista revogado." : "Sessões rotacionadas.");
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      err(e.message);
      err(USAGE);
      return 2;
    }
    if (e instanceof DriverStoreUnavailableError) {
      err("Redis indisponível ou credenciais inválidas. Nada foi alterado de forma confirmada.");
      return 1;
    }
    err(e instanceof Error && SAFE_MESSAGE.test(e.message) ? e.message : "Erro inesperado (detalhes omitidos para não vazar segredos).");
    return 1;
  }
}
