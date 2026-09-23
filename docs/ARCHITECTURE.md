# Finn — arquitetura do código

Spec completa: "Finn — Especificação Técnica (MVP)". Este doc descreve **como o código está organizado** e **quem é dono de quê** nas frentes paralelas.

## Fluxo de um turno

```
PWA (Porcupine "Finn" → WebRTC GPT-Live-1)
  └─ evento de delegação (client) com a transcrição
       └─ POST /api/orchestrator { transcript, contextId }
            ├─ classify()  — palavra-chave, sem LLM; checa cada domínio independente
            ├─ fan-out Promise.all → spotifyAgent.handle() / wazeAgent.handle()   (in-process)
            │     └─ runToolLoop(): Neuralake /chat/completions + tools → executores reais
            └─ aggregate() → { speech, clientActions, results }
  PWA executa clientActions (abre deep link do Waze) e devolve `speech` ao Live-1
```

Os agentes também são expostos via A2A (JSON-RPC `message/send`) para chamadas externas:

| Rota | O quê |
| --- | --- |
| `POST /api/orchestrator` | Entrada do PWA (`OrchestratorRequest` → `OrchestratorResponse`) |
| `POST /api/agents/{spotify,waze}` | Endpoint de task A2A |
| `GET /agents/{spotify,waze}/.well-known/agent.json` | Agent Card (rewrite → `/api/agents/[agent]/card`) |

## Contratos (congelados — mudanças só na integração)

- `src/lib/contracts/a2a.ts` — `Agent`, `AgentTaskInput`, `AgentResult`, `AgentCard`, wire format A2A
- `src/lib/contracts/tools.ts` — schemas das 4 tools (verbatim da spec) + tipos dos argumentos
- `src/lib/contracts/client-events.ts` — `ClientAction`, `OrchestratorRequest/Response`
- `src/lib/contracts/neuralake.ts` — `NeuralakeClient` (compatível OpenAI)

Infra compartilhada (também não mexer nas frentes; se precisar, anote no relatório):
`src/lib/agent-runtime.ts` (`runToolLoop`, `UserFacingError`), `src/lib/a2a-server.ts`,
`src/lib/neuralake/*`, `src/lib/env.ts`, `src/orchestrator/*`, `src/agents/registry.ts`.

## Posse por frente (worktrees)

| Branch | Pode criar/alterar |
| --- | --- |
| `feat/spotify-agent` | `src/agents/spotify/**`, `src/lib/spotify/**`, `src/app/api/spotify/**` |
| `feat/waze-agent` | `src/agents/waze/**`, `src/lib/waze/**` |
| `feat/pwa-voice` | `src/app/page.tsx`, `src/app/layout.tsx`, `src/app/manifest.ts`, `src/app/globals.css`, `src/components/**`, `src/lib/voice/**`, `src/app/api/realtime/**`, `public/**` |
| `feat/qa` | `tests/**` (testes de aceitação UC1–UC7, black-box contra os contratos abaixo) |

Cada frente pode adicionar env vars em `.env.example` **apenas na sua seção** e dependências no `package.json` (conflito de lockfile resolve-se na integração).

Regras para cada agente:
- Exportar `xxxAgent: Agent` de `src/agents/<id>/index.ts` (o registry já importa).
- Usar `runToolLoop` + `getNeuralakeClient()`; falha que o motorista deve ouvir → `throw new UserFacingError("frase curta")`.
- Resultado nunca carrega detalhe técnico em `speech`.

## Autenticação

`/api/orchestrator`, `/api/agents/*` (POST) e `/api/realtime/*` exigem `Authorization: Bearer <FINN_API_TOKEN>` via `authorize()` de `src/lib/auth.ts` (fail-closed se a env não existir). Agent Cards e o callback OAuth do Spotify são públicos. O PWA pede o token uma vez e guarda em `localStorage`.

## Continuação (`input-required`)

Quando um agente precisa de resposta do motorista (ex.: endereço de "casa"), o executor da tool retorna `continuation: <estado>`; o `AgentResult` sai com `status: "input-required"` e o orchestrator devolve `continuation: { agent, state }` ao PWA. O PWA **reenvia esse objeto no próximo POST** da mesma janela de conversa; o orchestrator então roteia o turno para aquele agente mesmo sem palavra-chave, e o agente recebe `input.continuation = state`. Backend continua stateless.

## Detalhes de integração (fixos — spotify/waze implementam, QA testa)

**Spotify** — `fetch` direto (sem SDK), para os testes poderem mockar `globalThis.fetch` por URL:
- Env: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REDIRECT_URI`, `SPOTIFY_REFRESH_TOKEN`
- Token: `POST https://accounts.spotify.com/api/token` (`grant_type=refresh_token`, Basic `client_id:client_secret`); access token cacheado em memória do módulo; `src/lib/spotify/auth.ts` exporta `resetSpotifyTokenCache()` (usado nos testes)
- `list_playlists`: `GET https://api.spotify.com/v1/me/playlists?limit=50` (seguindo `next`); resultado `{ playlists: [{ id, name }] }`
- `play_playlist`: resolve o nome → playlist (exato, senão fuzzy; sem match → resultado `{ found: false, suggestions: [...] }` para o modelo reagir) e `PUT https://api.spotify.com/v1/me/player/play` com `{ context_uri: "spotify:playlist:<id>" }`
- `toggle_playback`: `play` → `PUT /v1/me/player/play` sem body; `pause` → `PUT /v1/me/player/pause`; `skip` → `POST /v1/me/player/next`
- `401` → renova o token e tenta 1x; se falhar de novo → `UserFacingError`. `404`/`NO_ACTIVE_DEVICE` → `UserFacingError` pedindo pra abrir o Spotify em algum aparelho. Qualquer outro erro → `UserFacingError` curto.

**Waze**:
- Deep link: `https://waze.com/ul?q=<encodeURIComponent(endereço)>&navigate=yes`, em `ClientAction { type: "open_url", url, label }`
- Endereços salvos: rótulos canônicos `casa` e `trabalho` ("minha casa", "pra casa", "meu trabalho", "serviço", "escritório"… normalizam pra eles). Interface `AddressBook` em `src/lib/waze/address-book.ts`; seed opcional por env `WAZE_SAVED_ADDRESSES` (JSON `{"casa":"...","trabalho":"..."}`)
- `navigate_to({destination})` com rótulo sem endereço salvo → sem `open_url`, resultado `{ needs_address: "<rótulo>" }`, `continuation: { pendingLabel: "<rótulo>" }`
- Turno com `input.continuation.pendingLabel` → o `destination` recebido em `navigate_to` é o endereço: salva no rótulo e navega
- Rótulo com endereço salvo → navega para o endereço salvo

## Pendências conhecidas

- **Memória da Neuralake**: o mecanismo (campo/header) para memória por agente e Cross Memory não está documentado publicamente. `CompletionRequest.memoryScope` abstrai isso; o `HttpNeuralakeClient` ainda não envia nada (TODO `neuralake-memory`).
- **Suporte a `tools`** na Neuralake assumido idêntico ao da OpenAI — validar com a chave real.

## Dev

```bash
cp .env.example .env.local   # FINN_USE_MOCKS=1 roda tudo sem chaves
npm run dev
npm test && npm run typecheck && npm run lint
```
