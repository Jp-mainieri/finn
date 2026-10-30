# Contrato — identidade do motorista, sessão e `DriverStore` (etapa 1)

Status: **aprovado pelo dono em 2026-10-26** (com convites por script local). Decisão de base: identidade opção B (provisória), ver `ESTADO_ATUAL.md`.

## Invariantes

1. O `driverId` nunca vem do cliente como prova de identidade: só é válido o que está **dentro do token assinado**.
2. Falha fechada: segredo, Redis ou token ausente/inválido/expirado/revogado nunca libera acesso.
3. Segredos (token de sessão, código de convite, refresh token) nunca vão para log, erro ou resposta além do estritamente necessário.
4. Todo dado de motorista fica sob chave com escopo do motorista. Nenhuma estrutura global compartilhada entre motoristas.
5. Redis fora do ar ou lento nunca trava a voz silenciosamente: erro curto e falável ao motorista.

## Modelo

- **`driverId`**: `drv_` + 16 bytes aleatórios em base64url. Opaco; não deriva de Spotify, aparelho ou convite.
- **Prefixo de chaves**: `finn:<env>:` com `env = VERCEL_ENV ?? "development"`. Dev, preview e produção compartilham o mesmo Redis, então o prefixo é obrigatório.
- **Chaves**
  - `driver:<driverId>` → `{ driverId, label, status: "active"|"revoked", tokenVersion, createdAt, spotifyUserId? }`
  - `invite:<hmac-sha256(FINN_INVITE_PEPPER, codigo)>` → `{ label, maxUses, uses, expiresAt, createdAt, revoked }` (o código em claro nunca é guardado; o HMAC com segredo de servidor impede força bruta offline a partir de um dump do Redis)
  - `drivers` → conjunto de `driverId` (alimentado no mesmo EVAL do resgate; permite o `driver:list`)
  - `spotify-index:<spotifyUserId>` → `driverId` (reservado; usado na entrega 4)
  - `ratelimit:redeem:<ip>` → contador com TTL
- **Convite**: `FINN-XXXX-XXXX`, alfabeto sem caracteres ambíguos, resgate **atômico** (não pode ultrapassar `maxUses` sob corrida).
- **Token de sessão**: `v1.<payload base64url>.<assinatura>`, HMAC-SHA256 com `FINN_SESSION_SECRET`, comparação em tempo constante. Payload: `{ sub: driverId, iat, exp, tv: tokenVersion }`. Validade 90 dias.
- **Validação por requisição**: assinatura e `exp`, depois 1 leitura no Redis (`status === "active"` e `tv === tokenVersion`). Revogar = `status: "revoked"` ou incrementar `tokenVersion`; vale na próxima requisição.

## Interface (`src/lib/driver/store.ts`)

```ts
interface DriverStore {
  createDriver(input: { label: string }): Promise<Driver>;
  getDriver(driverId: string): Promise<Driver | null>;
  revokeDriver(driverId: string): Promise<void>;
  listDriversDetailed(): Promise<{ drivers: Driver[]; skipped: number }>; // ignora hash corrompido e conta quantos
  listDrivers(): Promise<Driver[]>; // índice `drivers` (SADD no resgate); usado só pelo script do dono: id, label, status, createdAt; nunca segredo
  rotateSessions(driverId: string): Promise<void>; // incrementa tokenVersion: invalida todos os tokens antigos sem banir o motorista
  createInvite(input: { label: string; maxUses: number; expiresAt: number }): Promise<{ code: string }>;
  redeemInvite(code: string): Promise<Driver | null>; // atômico; null se inválido/esgotado/expirado/revogado
  revokeInvite(code: string): Promise<boolean>; // true se o convite existia (o script avisa erro de digitação ou pepper de outro ambiente)
  incrementRateLimit(key: string, windowSeconds: number): Promise<number>;
}
```

Implementações: `MemoryDriverStore` (fake, usado em todos os testes) e `UpstashDriverStore` (`@upstash/redis`, lê `KV_REST_API_URL` e `KV_REST_API_TOKEN`). Seleção por `getDriverStore()`; em produção sem as variáveis, falha fechada.

## Rotas e autorização

- `POST /api/session` `{ inviteCode }` → `{ token, driverId, label }`. Público, mas com rate limit por IP (Redis) e resposta **idêntica** para código inexistente, expirado, esgotado ou revogado (não enumera convites).
- `GET /api/session` → valida o token e devolve `{ driverId, label }`.
- `authorizeDriver(request)` (novo, em `src/lib/auth.ts`) devolve `{ driverId }` ou `Response` de erro. Passa a proteger `/api/orchestrator` e `/api/realtime/*`.
- **Token legado `FINN_API_TOKEN`**: continua aceito **só** se `FINN_LEGACY_TOKEN_ENABLED=1` (transitório, para não quebrar o uso atual no carro até o PWA novo). Mapeia para um `driverId` fixo de dono. Valor ausente ou diferente de `1` = desligado. `/api/agents/*` (A2A externo) usa `authorizeA2A()` com o segredo próprio `FINN_A2A_TOKEN` (64 hex, diferente de `FINN_API_TOKEN`); `FINN_API_TOKEN` não abre mais o A2A. Nota: a variável `FINN_A2A_TOKEN` ainda **não existe** na Vercel; só será criada após a entrega 3 (ver `docs/ESTADO_ATUAL.md`).
- Criação e revogação de convites (decisão do dono, 2026-10-26: opção A): **script local** `npm run invite:create|invite:revoke|driver:revoke`, rodado pelo dono no próprio terminal com as credenciais do Redis. Nenhuma rota de admin no servidor. Reabre se o dono precisar convidar pelo celular com frequência (rota de admin com `FINN_ADMIN_TOKEN`, sujeita a security-review).

## Variáveis (só nomes e formato; valores são do dono)

| Nome | Formato | Quando |
|---|---|---|
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | já provisionadas pela integração | entrega 1 |
| `FINN_SESSION_SECRET` | 32 bytes hex (`openssl rand -hex 32`), distinto por ambiente | entrega 2 |
| `FINN_INVITE_PEPPER` | 32 bytes hex, distinto por ambiente; **trocar invalida todos os convites emitidos** | entrega 1 (correção) |
| `FINN_LEGACY_TOKEN_ENABLED` | `1` para ligar; ausente = desligado | entrega 2 |
| `FINN_TOKEN_ENC_KEY` | 32 bytes hex, distinto por ambiente | entrega 4 |

## Entregas (cada uma em branch e PR próprios, empilhados)

1. **Núcleo (lib apenas, sem rotas)**: `DriverStore`, `MemoryDriverStore`, `UpstashDriverStore`, assinatura e verificação do token, convites, rate limit. Sonnet (`api`). Crítica: qa + security-review (Opus).
2. **Rotas e autorização**: `/api/session`, `authorizeDriver`, flag do token legado, ferramenta de convites. `api`. Crítica.
3. **Perfil e endereços**: `RedisAddressBook` por `driverId`; remover a escrita no `baseBook` global. `api`. Crítica.
4. **Custódia do refresh token do Spotify**: criptografia AES-256-GCM no servidor; sai do `driverContext`. `api`. Crítica.
5. **PWA**: tela de convite, guarda o token de sessão, remove o prompt do token compartilhado. `web`. qa.

## Critério de pronto da entrega 1

- `npm test`, `npm run typecheck` e `npm run lint` passam; testes novos contra o fake, nenhum teste faz chamada de rede.
- Testes obrigatórios: token adulterado (payload e assinatura), expirado, `tv` desatualizado, motorista revogado, convite resgatado em paralelo além de `maxUses` (um só vence), convite expirado e revogado, código inexistente igual ao esgotado (mesma saída), rate limit estourado, `driverId` A nunca lê dado de B, chave sempre com prefixo de ambiente, produção sem variáveis falha fechada.
- Nenhum segredo em log, mensagem de erro ou snapshot de teste.
- Relatório no formato da Seção 5.

## Fora de escopo

Rate limit geral por motorista, métricas, OAuth do Spotify como login (opção C), memória da viagem, aliases de playlist.

## Histórico de mudanças

- 2026-10-26: aprovado com convites por script local (opção A).
- 2026-10-26: adições aprovadas pelo dono após security-review da entrega 1: pepper HMAC no hash do convite e `rotateSessions` (baratas agora, caras depois que houver convites emitidos).
- M2 (credencial do Redis separada) decidido e revertido: um Redis só, por custo (ver `ESTADO_ATUAL.md`).
- 2026-10-26: `listDrivers()` e índice `drivers` adicionados pelo orquestrador (adição mecânica à decisão A: sem listagem o dono não tem como saber qual `driverId` revogar). Sem decisão de produto envolvida.
- 2026-10-26: B3 (vínculo de ambiente no token) fechado como **não fazer**: segredos de sessão distintos por ambiente já impedem token de preview em produção.
- 2026-10-26 (entrega 2, rodada de correções): `revokeInvite` devolve `boolean`; `listDriversDetailed()` acrescentado (registros corrompidos são pulados e contados); resgate confere `TYPE` do índice `drivers` antes de escrever; `/api/session` exige `Content-Type: application/json` (415) e corpo <= 2 KB (413) antes de qualquer Redis.
