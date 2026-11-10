# Finn — arquitetura do código

Spec completa: "Finn — Especificação Técnica (MVP)". Este doc descreve **como o código está organizado** e **quem é dono de quê** nas frentes paralelas.

## Fluxo de um turno (Padrão Atual: Whisper STT + Natural TTS)

```
PWA (Porcupine "Finn" ou botão → AudioIO 16 kHz PCM + VAD Local no browser)
  └─ POST /api/realtime/transcribe (Groq whisper-large-v3-turbo ~200ms / fallback OpenAI)
       └─ POST /api/orchestrator { transcript, contextId, continuation }
            ├─ classify()  — palavra-chave lida do próprio Agent, sem LLM
            ├─ fan-out Promise.all → spotifyAgent.handle() / wazeAgent.handle()   (in-process)
            │     └─ runToolLoop(): Neuralake /chat/completions + tools → executores reais
            │        (com FINN_FAST_SPEECH=1: responde em 1 round-trip determinístico)
            └─ aggregate() → { speech, clientActions, results, continuation }
  PWA fala `speech` (SpeechSynthesis nativo iOS ou OpenAI TTS HD em /api/realtime/tts)
  e executa clientActions (salva endereços no aparelho e abre o deep link do Waze)
```
*(O fluxo WebRTC do GPT-Live-1 em `live-session.ts` e `/api/realtime/session` permanece preservado no código, porém bloqueado como "EM BREVE" por padrão para controle de custos).*

Os agentes também são expostos via A2A (JSON-RPC `message/send`) para chamadas externas:

| Rota | O quê |
| --- | --- |
| `POST /api/orchestrator` | Entrada do PWA (`OrchestratorRequest` → `OrchestratorResponse`). `transcript` com no máximo 2000 caracteres (400). Limite por motorista (`orchestrator`): 20/min por instância, 600/dia (Redis, dia de São Paulo); 429 com `scope` `burst` ou `day`. |
| `POST /api/agents/{spotify,waze}` | Endpoint de task A2A (exige `Authorization: Bearer <FINN_A2A_TOKEN>`; desligado sem a variável válida). Limite por motorista (`a2a`, roda como o dono): 20/min por instância, 600/dia; 429 antes de ler o corpo ou chamar o agente; falha de autenticação não conta; `transcript` até 2000 caracteres (erro JSON-RPC -32602); contador fora = 503, sem falha aberta do dono |
| `POST /api/realtime/transcribe` | Transcrição de voz, só WAV PCM (cabeçalho RIFF/WAVE validado), no máximo 20 s e 1 MB decodificado; 415 para formato não suportado, 400 para WAV inválido ou longo, 413 acima de 1 MB; sempre encaminhado ao provedor como `audio.wav` / `audio/wav`, ignorando `mimeType` e nome do cliente (Groq `whisper-large-v3-turbo` ou OpenAI `gpt-4o-mini-transcribe`). Limite por motorista (`stt`): 20/min por instância, 600/dia (Redis, dia de São Paulo); 429 com `scope` `burst` ou `day`. |
| `POST /api/realtime/tts` | Síntese de voz HD opcional (`gpt-4o-mini-tts`; com `FINN_TTS_PROVIDER=gemini` usa o Gemini TTS e cai para o OpenAI se falhar, módulo `src/lib/tts-providers.ts`). Limite por motorista (`tts`): 20/min por instância, 600/dia (Redis, dia de São Paulo); 429 com `scope` `burst` ou `day`. |
| `POST /api/realtime/session` | Troca SDP do WebRTC com o GPT-Live-1 (desativado por padrão; exige `ENABLE_GPT_LIVE=1`). Limite por motorista (`live`): 5/min por instância, 30/dia (Redis, dia de São Paulo); 429 com `scope` `burst` ou `day`. |
| `GET /api/spotify/login` → `/callback` | OAuth do Spotify (suporta tanto setup do servidor quanto conexão por motorista no PWA) |
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

`/api/orchestrator` e `/api/realtime/*` exigem sessão de motorista via `authorizeDriver()` de `src/lib/auth.ts` (token de sessão assinado; o token legado `FINN_API_TOKEN` só é aceito com `FINN_LEGACY_TOKEN_ENABLED=1`). `/api/agents/*` (POST, A2A) usa `authorizeA2A()` e exige `Authorization: Bearer <FINN_A2A_TOKEN>`: segredo próprio, 64 hex, diferente de `FINN_API_TOKEN`. Sem a variável válida o endpoint fica desligado (503); token ausente ou errado dá 401. `FINN_API_TOKEN` não abre o A2A. Agent Cards (`GET .../card` e `/agents/{spotify,waze}/.well-known/agent.json`) e o callback OAuth do Spotify são públicos. O PWA entra por convite: a tela `InviteSetup` limpa o código no aparelho (maiúsculas, sem espaços, hífens Unicode, caracteres de largura zero ou largura total) e só envia ao `POST /api/session` um código com a forma `FINN-XXXX-XXXX`; um código malformado é recusado no aparelho ("Confira o código.") e não gasta tentativa do rate limit do servidor (o servidor responde 401 para código malformado, como para um desconhecido). Guarda só o **token de sessão** (`v1.`) em `localStorage` (chave `finn.apiToken`, `TokenStore`), e só se a resposta casar `/^v1\.[A-Za-z0-9._-]+$/` com no máximo 1024 caracteres; um valor guardado fora do formato é descartado ao ler (o token legado, de ASCII imprimível, continua valendo). O código do convite, o `driverId` e o `label` da resposta não são guardados nem logados. Resgate e rotas do Spotify têm prazo de 10 s (o botão não fica preso em "Entrando…"); `Retry-After` só vale como inteiro decimal, com teto de 60 min. Um token já guardado (de sessão ou o legado, enquanto o servidor o aceitar) continua valendo sem tela; um 401 do orquestrador, das rotas realtime ou das rotas do Spotify apaga o token local e volta à tela de convite. **"Sair deste aparelho" e "Entrar com outro convite" só apagam ou sobrescrevem o token local: a sessão continua válida no servidor até expirar (90 dias)** (decisão do dono, 2026-10-28); para um aparelho perdido ou roubado, o dono roda `npm run driver:rotate` (invalida todas as sessões daquele motorista). Sair ou trocar de convite também cancela uma navegação ao Spotify em curso, ignora respostas em voo do motorista anterior e limpa legendas e ações pendentes na tela. **O aparelho não guarda refresh token do Spotify nem endereços**: o Spotify é conectado pelo servidor (`POST /api/spotify/connect` com Bearer devolve `{ url }`; o PWA só navega, na mesma janela, para a URL interpretada `https://accounts.spotify.com/authorize`, e consulta `GET /api/spotify/connection` ao abrir Configurações e quando o app volta a ficar visível ou volta do bfcache, `pageshow`); os endereços ficam no servidor, por motorista, e só o ditado por voz os grava. A cada carregamento do app (idempotente) o PWA apaga de `finn.driverSettings` os campos antigos (`spotifyRefreshToken`, `casa`, `trabalho`, `savedAddresses`), mantém só as preferências de voz, e retira `?spotify_refresh_token=` / `spotify_token` da URL sem ler o valor. 429 e 503 do orquestrador e da transcrição são ditos pela voz do aparelho (sem rede): "Muitas tentativas, tente de novo em instantes." (429 de rajada ou sem `scope`), "Você atingiu o limite de uso de hoje. Volte amanhã." (429 só quando o corpo traz exatamente `scope: "day"`; o PWA lê o corpo só no 429, com teto de 1 KB e prazo, e o texto nunca vem do servidor) e "O Finn está fora do ar agora, tente de novo daqui a pouco." (503). O convite e o Spotify não têm `scope`.

## Continuação (`input-required`)

Quando um agente precisa de resposta do motorista (ex.: endereço de "casa"), o executor da tool retorna `continuation: <estado>`; o `AgentResult` sai com `status: "input-required"` e o orchestrator devolve `continuation: { agent, state }` ao PWA. O PWA **reenvia esse objeto no próximo POST** da mesma janela de conversa; o orchestrator então roteia o turno para aquele agente mesmo sem palavra-chave, e o agente recebe `input.continuation = state`. Backend continua stateless.

- Se o turno bate **só** com palavras-chave de outros domínios ("toca rock" enquanto o waze espera um endereço), o orchestrator descarta a continuação (mudança de assunto).
- O PWA descarta a continuação quando a janela de conversa fecha (silêncio) e substitui pela da resposta mais recente.
- Quem decide se o turno ainda aguarda resposta é a **última** saída de tool do turno. Turno `failed` nunca devolve `clientActions`; ações repetidas são deduplicadas.

## Detalhes de integração (fixos — spotify/waze implementam, QA testa)

**Spotify** — `fetch` direto (sem SDK), para os testes poderem mockar `globalThis.fetch` por URL:
- Env: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REDIRECT_URI`, `SPOTIFY_REFRESH_TOKEN`
- Token: `POST https://accounts.spotify.com/api/token` (`grant_type=refresh_token`, Basic `client_id:client_secret`); access token cacheado em memória do módulo; `src/lib/spotify/auth.ts` exporta `resetSpotifyTokenCache()` (usado nos testes)
- `list_playlists`: `GET https://api.spotify.com/v1/me/playlists?limit=50` (seguindo `next`); resultado `{ playlists: [{ id, name }] }`
- `play_playlist`: resolve o nome → playlist (exato, senão fuzzy; sem match → resultado `{ found: false, suggestions: [...] }` para o modelo reagir) e `PUT https://api.spotify.com/v1/me/player/play` com `{ context_uri: "spotify:playlist:<id>" }`
- `toggle_playback`: `play` → `PUT /v1/me/player/play` sem body; `pause` → `PUT /v1/me/player/pause`; `skip` → `POST /v1/me/player/next`
- Sem aparelho ativo (`404`/`NO_ACTIVE_DEVICE`) em `play_playlist` ou retomar → `GET /v1/me/player/devices` (escopo `user-read-playback-state`), escolhe ativo > smartphone > computador > outro não restrito e repete com `?device_id=`. Sem aparelho ou falha na consulta → mantém o erro amigável. Pausar/pular não fazem fallback.
- `401` → renova o token e tenta 1x; se falhar de novo → `UserFacingError`. `404`/`NO_ACTIVE_DEVICE` → `UserFacingError` pedindo pra abrir o Spotify em algum aparelho. Qualquer outro erro → `UserFacingError` curto.

**Waze**:
- Deep link: `https://waze.com/ul?q=<encodeURIComponent(endereço)>&navigate=yes`, em `ClientAction { type: "open_url", url, label }`
- Endereços salvos: rótulos canônicos `casa` e `trabalho` ("minha casa", "pra casa", "meu trabalho", "serviço", "escritório"… normalizam pra eles). Interface `AddressBook` em `src/lib/waze/address-book.ts`; seed opcional por env `WAZE_SAVED_ADDRESSES` (JSON `{"casa":"...","trabalho":"..."}`)
- `navigate_to({destination})` com rótulo sem endereço salvo → sem `open_url`, resultado `{ needs_address: "<rótulo>" }`, `continuation: { pendingLabel: "<rótulo>" }`
- Turno com `input.continuation.pendingLabel` → o `destination` recebido em `navigate_to` é o endereço: salva no rótulo e navega
- Rótulo com endereço salvo → navega para o endereço salvo
- Destino vazio → resultado `{ needs_destination: true }`, `continuation: { awaitingDestination: true }`

**Formatos de resultado das tools** (o que o modelo vê; nunca contém URL):
- `play_playlist`: `{ found: true, playlist: { id, name } }` ou `{ found: false, requested, suggestions: string[] (≤5) }` sem tocar nada
- `list_playlists`: `{ playlists: [{ id, name }] }` · `toggle_playback`: `{ ok: true, action }`
- `navigate_to`: `{ navigating_to, saved_place?, address_saved_now? }`, ou `needs_address` / `needs_destination`

## Decisões de produto

- **Camada de Voz STT+TTS e Bloqueio do GPT-Live-1 (2026-10-22)**: substituído o GPT-Live-1 ($0,05/min) como motor padrão por `SttTtsVoiceSession` (VAD local 16 kHz no `AudioIO` + Groq `whisper-large-v3-turbo` gratuito + voz nativa aprimorada do iOS ou OpenAI TTS HD opcional), reduzindo o custo do MVP a zero. O GPT-Live-1 fica marcado como `EM BREVE` no modal de configurações e bloqueado na API (`403`) salvo `ENABLE_GPT_LIVE=1`.
- **Fast-Path de 1 Round-Trip (`FINN_FAST_SPEECH=1`, 2026-10-22)**: corta a 2ª chamada de LLM à Neuralake quando a tool retorna confirmação determinística no 1º passo, economizando ~1,5s por comando.
- **Multi-User Stateless & Agentes Plug-and-Play (2026-10-22)**: cada agente declara suas próprias `keywords` e `failureSpeech`; o PWA envia `driverContext` (`savedAddresses` e `spotifyRefreshToken`) permitindo que cada motorista conecte seu próprio Spotify e salve seus endereços no aparelho. (Substituído em 2026-10-27: o servidor guarda ambos por `driverId` e o PWA não envia mais `driverContext`; ver Autenticação.)
- **Personalização, Learning & Cache Redis**: especificado na íntegra em [`docs/PERSONALIZATION_AND_LEARNING.md`](./PERSONALIZATION_AND_LEARNING.md), estruturado em **4 camadas**:
  1. **Camada 1 (Memória Implícita de Hábitos e Apelidos):** lugares pessoais dinâmicos no Waze (além de casa/trabalho: *"academia"*, *"mãe"*, *"faculdade"*) + aliases musicais (`"treino"` → `"Drumz"`) e ranking das Top 5 playlists para desempate de fuzzy-match e comando *"coloca um som"*.
  2. **Camada 2 (Rotinas Contextuais por Horário e Dia da Semana):** predição de rota + playlist com base no dia/hora (ex.: *"Bom dia! Indo pro trabalho e colocando Lo-Fi?"*) e personalização do estilo de fala do copiloto (*Direto* vs. *Copiloto*).
  3. **Camada 3 (Memória Episódica, Curto Prazo da Viagem & Background Learning):** buffer dos últimos 2–3 turnos da viagem para escolhas naturais (*"a segunda"*) e correção imediata (*"não, essa não, toca a outra"*), escopo por perfil na Neuralake (`memoryScope`) e consolidação assíncrona no Redis (`gru1`) via `waitUntil` sem impacto na latência de voz.
  4. **Camada 4 (Harness Agêntico Autônomo, Proativo & Auto-Otimizável):** descoberta dinâmica de Agent Cards/MCP com roteador de 2 estágios, execução em grafo (DAG) encadeando múltiplos agentes (ex.: Calendar → Waze), gatilhos proativos por contexto/GPS e auto-compilação de fast-paths determinísticos no Redis + avaliação por feedback implícito.
- **UC5 (2026-09-23)**: o modelo pode chamar `play_playlist` direto; o executor sempre resolve o nome contra as playlists do motorista (fuzzy) antes de tocar, e ambiguidade vira `found: false` com sugestões. Economiza uma ida ao modelo (~1,3s). `list_playlists` fica para UC4 e para quando o modelo quiser conferir.
- **Auto-seleção de aparelho (2026-09-23)**: fora da spec original; adicionada porque no carro o Spotify costuma estar aberto mas inativo. Exigiu o 4º escopo OAuth `user-read-playback-state`.
- **Fora do MVP**: busca no catálogo do Spotify (`/v1/search`) para playlists que o motorista não segue; correção por voz do tipo "não, essa não" (exigiria lembrar a última escolha — planejado na Etapa 1 de [`PERSONALIZATION_AND_LEARNING.md`](./PERSONALIZATION_AND_LEARNING.md)).

## Pendências conhecidas

- **Memória da Neuralake**: o mecanismo (campo/header) para memória por agente e Cross Memory não está documentado publicamente. `CompletionRequest.memoryScope` abstrai isso; o `HttpNeuralakeClient` ainda não envia nada (TODO `neuralake-memory`).
- ~~Suporte a `tools` na Neuralake~~: confirmado em produção (2026-09-23), formato OpenAI.

## Dev

```bash
cp .env.example .env.local   # FINN_USE_MOCKS=1 roda tudo sem chaves
npm run dev
npm test && npm run typecheck && npm run lint
```
