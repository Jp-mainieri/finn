# Contrato — identidade do motorista, sessão e `DriverStore` (etapa 1)

Status: **proposta, aguardando OK do dono**. Decisão de base: identidade opção B (provisória), ver `ESTADO_ATUAL.md`.

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
  - `invite:<sha256(codigo)>` → `{ label, maxUses, uses, expiresAt, createdAt, revoked }` (o código em claro nunca é guardado)
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
  createInvite(input: { label: string; maxUses: number; expiresAt: number }): Promise<{ code: string }>;
  redeemInvite(code: string): Promise<Driver | null>; // atômico; null se inválido/esgotado/expirado/revogado
  revokeInvite(code: string): Promise<void>;
  incrementRateLimit(key: string, windowSeconds: number): Promise<number>;
}
```

Implementações: `MemoryDriverStore` (fake, usado em todos os testes) e `UpstashDriverStore` (`@upstash/redis`, lê `KV_REST_API_URL` e `KV_REST_API_TOKEN`). Seleção por `getDriverStore()`; em produção sem as variáveis, falha fechada.

## Rotas e autorização

- `POST /api/session` `{ inviteCode }` → `{ token, driverId, label }`. Público, mas com rate limit por IP (Redis) e resposta **idêntica** para código inexistente, expirado, esgotado ou revogado (não enumera convites).
- `GET /api/session` → valida o token e devolve `{ driverId, label }`.
- `authorizeDriver(request)` (novo, em `src/lib/auth.ts`) devolve `{ driverId }` ou `Response` de erro. Passa a proteger `/api/orchestrator` e `/api/realtime/*`.
- **Token legado `FINN_API_TOKEN`**: continua aceito **só** se `FINN_LEGACY_TOKEN_ENABLED=1` (transitório, para não quebrar o uso atual no carro até o PWA novo). Mapeia para um `driverId` fixo de dono. Valor ausente ou diferente de `1` = desligado. `/api/agents/*` (A2A externo) continua com `authorize()` atual, fora desta etapa.
- Criação e revogação de convites: ver decisão pendente (script local ou rota de admin).

## Variáveis (só nomes e formato; valores são do dono)

| Nome | Formato | Quando |
|---|---|---|
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | já provisionadas pela integração | entrega 1 |
| `FINN_SESSION_SECRET` | 32 bytes hex (`openssl rand -hex 32`), distinto por ambiente | entrega 2 |
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
