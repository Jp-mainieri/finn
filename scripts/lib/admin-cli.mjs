// Owner CLI core (invites and drivers). Run through scripts/driver-admin.mjs.
// Relative imports only (no "@/" alias). Credentials come from process.env: the owner
// runs `node --env-file=<file> ...`; this code never reads .env* files itself.
// Never prints the invite pepper, the session secret, the Redis URL/token or any session token.
import { existsSync } from "node:fs";
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
  invite:revoke            (o código é pedido sem eco, ou vem por stdin; evite passá-lo em argv: fica no histórico e no ps)
  driver:list
  driver:revoke <driverId> [--yes]       revoga o motorista e apaga o token do Spotify guardado
  driver:purge <driverId> [--yes]        apaga o token do Spotify e os endereços salvos do motorista (não revoga)
  driver:rotate <driverId> [--yes]

--env é obrigatório e não tem padrão (define o prefixo finn:<env>:). Para production, --confirm-production também.
--env-file <arquivo> carrega KV_REST_API_URL, KV_REST_API_TOKEN e FINN_INVITE_PEPPER do arquivo (variáveis já presentes no
ambiente do processo têm precedência). Sem TTY, driver:revoke, driver:rotate e driver:purge exigem --yes.
Use "npm run -s" para que o npm não imprima a linha de comando, e redirecione nada além do que precisa do código impresso.`;

class UsageError extends Error {}

const VALUE_FLAGS = new Set(["env", "env-file", "label", "max-uses", "days"]);
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

/** Reads a secret without echo on a TTY, or the first stdin line when piped. */
async function defaultReadSecret(promptText) {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let data = "";
    for await (const chunk of stdin) {
      data += chunk;
      if (data.includes("\n") || data.length > 256) break;
    }
    return data.split(/\r?\n/)[0].trim();
  }
  process.stderr.write(promptText);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    let buf = "";
    const onData = (ch) => {
      for (const c of ch) {
        if (c === "\u0003") {
          stdin.setRawMode(false);
          process.stderr.write("\n");
          process.exit(130);
        } else if (c === "\r" || c === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          resolve(buf.trim());
          return;
        } else if (c === "\u007f") buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.on("data", onData);
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

/** Same reading as the server (FINN_OWNER_DRIVER_ID, ends trimmed, exact comparison afterwards); null when absent or invalid. */
function ownerIdFrom(vars) {
  const v = vars.FINN_OWNER_DRIVER_ID?.trim();
  return v && isValidDriverId(v) && v !== "drv_legacy_owner_000000000" ? v : null;
}

const OWNER_EFFECT = {
  "driver:revoke": "REVOGAR o dono derruba as sessões do carro e faz o token legado e o A2A falharem; o Spotify e os endereços do servidor deixam de funcionar para o carro.",
  "driver:purge": "APAGAR dados do dono apaga os endereços ditados e o blob de Spotify residual; o Spotify do carro (SPOTIFY_REFRESH_TOKEN) continua.",
  "driver:rotate": "ROTACIONAR o dono invalida as sessões atuais dele (o app do carro pede novo convite); o token legado e o A2A não são afetados.",
};

function when(ms) {
  return new Date(ms).toISOString();
}

/**
 * @param {string[]} argv  e.g. ["invite:create", "--env", "preview", "--label", "Carro"]
 * @param {{ env?: Record<string,string|undefined>, out?: (s:string)=>void, err?: (s:string)=>void,
 *           createStore?: (env:string, vars:object)=>object, confirm?: (q:string)=>Promise<boolean>,
 *           now?: ()=>number, readSecret?: (prompt:string)=>Promise<string>, isTTY?: boolean,
 *           loadEnvFile?: (path:string)=>void }} [deps]
 * @returns {Promise<number>} exit code
 */
export async function run(argv, deps = {}) {
  const vars = deps.env ?? process.env;
  const out = deps.out ?? ((s) => process.stdout.write(`${s}\n`));
  const err = deps.err ?? ((s) => process.stderr.write(`${s}\n`));
  const confirm = deps.confirm ?? defaultConfirm;
  const createStore = deps.createStore ?? defaultCreateStore;
  const now = deps.now ?? Date.now;
  const readSecret = deps.readSecret ?? defaultReadSecret;
  const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY);
  const loadEnvFile = deps.loadEnvFile ?? ((path) => process.loadEnvFile(path));

  try {
    const { command, flags, positional } = parseArgs(argv);
    const commands = ["invite:create", "invite:revoke", "driver:list", "driver:revoke", "driver:rotate", "driver:purge"];
    if (!commands.includes(command)) throw new UsageError(command ? `Comando desconhecido: ${command}` : "Comando ausente.");

    if (!flags.env) throw new UsageError("Recusado: --env é obrigatório (production, preview ou development). Não há padrão.");
    if (!ENVS.includes(flags.env)) throw new UsageError("Recusado: --env precisa ser production, preview ou development.");
    if (flags.env === "production" && !flags["confirm-production"]) {
      throw new UsageError("Recusado: em production é preciso passar também --confirm-production.");
    }

    if (flags["env-file"] !== undefined) {
      const path = flags["env-file"];
      if (!existsSync(path)) throw new UsageError("Recusado: o arquivo de --env-file não existe.");
      try {
        loadEnvFile(path); // the file is the owner's; only its path is handled here, values are never printed
      } catch {
        throw new UsageError("Não foi possível carregar o arquivo de --env-file.");
      }
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
      if (positional.length > 1) throw new UsageError("invite:revoke aceita no máximo um código (prefira omiti-lo: ele é pedido sem eco).");
      const code = positional.length === 1 ? positional[0] : await readSecret("Código do convite (sem eco): ");
      if (!code) throw new UsageError("Código do convite não informado.");
      if (!(await store.revokeInvite(code))) {
        err("Convite não encontrado (confira o código e o --env/pepper). Nada foi alterado.");
        return 1;
      }
      out("Convite revogado.");
      return 0;
    }

    if (command === "driver:list") {
      const { drivers, skipped } = await store.listDriversDetailed();
      if (skipped > 0) err(`Aviso: ${skipped} entrada(s) do índice foram ignoradas (id inválido, registro ausente ou corrompido).`);
      if (drivers.length === 0) out("Nenhum motorista.");
      const ownerId = ownerIdFrom(vars);
      if (!ownerId) err("Aviso: FINN_OWNER_DRIVER_ID não definida neste ambiente (ou inválida); nenhuma linha é marcada como dono.");
      for (const d of drivers) out(`${d.driverId}\t${d.label}\t${d.status}\t${when(d.createdAt)}${d.driverId === ownerId ? "\t(dono)" : ""}`);
      return 0;
    }

    // driver:revoke / driver:rotate / driver:purge
    if (positional.length !== 1) throw new UsageError(`Informe o driverId: ${command} <driverId>`);
    const id = positional[0];
    const driver = isValidDriverId(id) ? await store.getDriver(id) : null;
    if (!driver) {
      err("Motorista não encontrado neste ambiente. Confira o driverId (use driver:list). Nada foi alterado.");
      return 1;
    }
    out(`Alvo: "${driver.label}" (${driver.driverId}), status ${driver.status}, criado em ${when(driver.createdAt)}`);
    const targetIsOwner = driver.driverId === ownerIdFrom(vars);
    if (targetIsOwner) err(`ATENÇÃO: este motorista é o DONO (FINN_OWNER_DRIVER_ID). ${OWNER_EFFECT[command]}`);
    if (command === "driver:rotate" && driver.status !== "active") {
      err("Este motorista já está revogado: rotacionar sessões não tem efeito. Nada foi alterado.");
      return 1;
    }
    if (command === "driver:revoke" && driver.status === "revoked") {
      // Idempotent: revoking again only makes sure the stored Spotify token is gone.
      await store.revokeDriver(driver.driverId);
      out("Já estava revogado. O token do Spotify guardado foi apagado, se havia.");
      return 0;
    }
    const verb =
      (targetIsOwner ? "[DONO] " : "") +
      (command === "driver:revoke"
        ? "REVOGAR este motorista (o token dele deixa de valer e o token do Spotify guardado é apagado)"
        : command === "driver:purge"
          ? "APAGAR o token do Spotify e os endereços salvos deste motorista (ele terá de conectar o Spotify de novo)"
          : "ROTACIONAR as sessões deste motorista (todos os tokens antigos deixam de valer)");
    if (!flags.yes && !isTTY) {
      err("Recusado: sem terminal interativo é preciso passar --yes para confirmar. Nada foi alterado.");
      return 1;
    }
    if (!flags.yes && !(await confirm(`${verb} em ${flags.env}?`))) {
      err("Cancelado. Nada foi alterado.");
      return 1;
    }
    if (command === "driver:revoke") await store.revokeDriver(driver.driverId);
    else if (command === "driver:purge") await store.purgeDriverData(driver.driverId);
    else await store.rotateSessions(driver.driverId);
    out(
      command === "driver:revoke"
        ? "Motorista revogado. Token do Spotify guardado apagado."
        : command === "driver:purge"
          ? "Token do Spotify e endereços salvos apagados."
          : "Sessões rotacionadas.",
    );
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
    if (e instanceof Error && /FINN_INVITE_PEPPER|invite pepper/i.test(e.message)) {
      err("Pepper ausente ou inválido para este ambiente (FINN_INVITE_PEPPER: 64 hex, distinto do segredo de sessão).");
      return 1;
    }
    err(e instanceof Error && SAFE_MESSAGE.test(e.message) ? e.message : "Erro inesperado (detalhes omitidos para não vazar segredos).");
    return 1;
  }
}
