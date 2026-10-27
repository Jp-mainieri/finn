# Contrato — dono registrado e PWA com convite (etapa 1, entrega 5)

Status: **aprovado pelo dono em 2026-10-27** (com as 3 decisões embutidas). Base: [`identidade-e-perfil.md`](./identidade-e-perfil.md), [`isolamento-por-motorista.md`](./isolamento-por-motorista.md), [`custodia-token-spotify.md`](./custodia-token-spotify.md). Decisão do dono (A1, opção C, 2026-10-27): o dono vira um motorista de verdade (convite), `FINN_OWNER_DRIVER_ID` aponta para ele, o token legado é desligado.

## Objetivo

1. **Servidor (5a, `api`):** "dono" deixa de ser o id fixo do token legado e passa a ser o `driverId` real em `FINN_OWNER_DRIVER_ID`. O dono mantém o Spotify e os endereços do servidor sem depender do `FINN_API_TOKEN`. Sai o que o PWA novo não envia mais (`driverContext`).
2. **PWA (5b, `web`):** tela de convite no lugar do campo de token, botão "Conectar Spotify" falando com `/api/spotify/connect`, sem token do Spotify no aparelho, sem endereços digitados (o servidor os guarda), falas locais para 429 e 503.

Fecha o A1. Depois desta entrega, os convites em produção só dependem do A3 (firewall e alerta de cota), do M3 e do roteiro de virada do dono.

## Invariantes

1. Dono = `getOwnerDriverId()`: o valor válido de `FINN_OWNER_DRIVER_ID` (formato `drv_` + 22 base64url) ou, **enquanto `FINN_LEGACY_TOKEN_ENABLED=1`**, o id legado `drv_legacy_owner_000000000`. Sem nenhum dos dois, ninguém é dono e ninguém usa o token do servidor (falha fechada); o A2A fica desligado (503).
2. Com a flag legada ligada e `FINN_OWNER_DRIVER_ID` definida, o token legado mapeia para **esse mesmo id** (o dono não perde Spotify na virada).
3. Só o dono usa `SPOTIFY_REFRESH_TOKEN` e `WAZE_SAVED_ADDRESSES`. Nada mais muda nas regras das entregas 3 e 4.
4. O PWA nunca guarda refresh token do Spotify nem endereço do motorista. Guarda só o token de sessão (`v1.`), no mesmo `localStorage` que hoje guarda o token legado.
5. O servidor continua ignorando tudo que o cliente mande além de `transcript`, `contextId` e `continuation`.

## 5a — servidor (`api`, branch `feat/owner-driver-id`)

- `getOwnerDriverId()` e `isOwner(driverId)` em `src/lib/auth.ts` (ou módulo próprio). Substituem todo uso de `LEGACY_OWNER_DRIVER_ID` como "dono": `spotify/auth.ts`, `spotify/connect.ts`, `spotify/token-vault.ts`, `waze/address-book.ts`, `a2a-server.ts`, rotas `connect`/`connection`. O 403 de `connect`, a recusa em `saveSpotifyRefreshToken`, o `connected` por `SPOTIFY_REFRESH_TOKEN` e o `DELETE` que limpa blob residual valem para o dono.
- Token legado: com a flag ligada, mapeia para `getOwnerDriverId()` (nunca para outro id). Validar o formato de `FINN_OWNER_DRIVER_ID`; inválida = como ausente, com um log fixo por processo, sem valor.
- A2A: roda como `getOwnerDriverId()`; sem dono = 503 "A2A endpoint disabled".
- Remover `driverContext` do pedido: `OrchestratorRequest.driverContext`, `DriverContext`, a leitura em `/api/orchestrator`, `AgentTaskInput.driverContext`, a emissão de `save_address` (`waze/tools.ts`, `agent-runtime.ts`) e o tipo `save_address` de `ClientAction`. O orquestrador lê só `transcript`, `contextId`, `continuation`. Campo extra no corpo continua ignorado, sem erro (PWA antigo em cache).
- **Fora do escopo do `api`:** `src/components/**` e `src/lib/voice/**` (o `web` ajusta o consumo logo depois, na branch seguinte; o typecheck desta branch deve passar: deixe os tipos removidos como `@deprecated` apenas se `src/lib/voice/**` ainda os importar, e remova na 5b).
- Testes obrigatórios: dono = id de `FINN_OWNER_DRIVER_ID` usa o token do servidor e a semente; id legado com `FINN_OWNER_DRIVER_ID` definida **não** é dono se a flag estiver desligada; legado ligado + variável definida: token legado mapeia para o id real; variável inválida; sem flag e sem variável: ninguém é dono, nenhum caminho alcança `SPOTIFY_REFRESH_TOKEN`; convidado comum nunca é dono; A2A 503 sem dono; mutação executada: `isOwner` sempre verdadeiro derruba teste; corpo com `driverContext` é ignorado.
- Variável nova: `FINN_OWNER_DRIVER_ID` (`.env.example` só o nome comentado). O orquestrador a cria na Vercel quando o dono informar o `driverId`.

## 5b — PWA (`web`, branch `feat/pwa-invite-session`, empilhada sobre a 5a)

- **Tela de convite** (`InviteSetup`, substitui `TokenSetup`): campo do código `FINN-XXXX-XXXX` (maiúsculas, sem ambíguos), envia `POST /api/session` com `{ inviteCode }`, `Content-Type: application/json`. Sucesso (`200 { token, driverId, label }`): guarda `token` no `TokenStore` (mesma chave) e entra. Respostas: 401 "Convite inválido." (texto único, não enumera), 429 com `Retry-After` ("Muitas tentativas, tente em N min."), 400/413/415 "Confira o código.", 503 ou rede "Servidor indisponível, tente de novo." Nada de `driverId` ou token em log, console ou URL.
- **Token já guardado** (legado ou sessão): segue funcionando sem tela; o servidor decide. Um 401 volta à tela de convite (como hoje volta ao campo de token). Em Configurações, "Entrar com outro convite" reabre a tela e, em sucesso, **sobrescreve** o token; "Sair deste aparelho" apaga o token local.
- **Falas locais (TTS do aparelho, sem rede)** para 429 e 503 vindos do orquestrador e das rotas realtime, no mesmo padrão das falas de falha atuais: "Muitas tentativas, tente de novo em instantes." e "O Finn está fora do ar agora, tente de novo daqui a pouco." Falha de rede continua como hoje.
- **Spotify:** em `DriverSettingsModal`, o campo de colar refresh token e o link `/api/spotify/login` saem. Entra o estado de conexão (`GET /api/spotify/connection` → `{ connected }`) e os botões "Conectar Spotify" (`POST /api/spotify/connect` com Bearer → `{ url }`, navegar até a URL), "Desconectar" (`DELETE /api/spotify/connection`). Reconsulta o estado quando o app volta a ficar visível (`onVisible`). Para o dono, `connected` vem do servidor; sem botão de conectar se `connected` e dono (403 do `connect` = "não se aplica", sem erro). Erros do Spotify/Redis: mensagem curta e fixa.
- **Limpeza:** remove `spotifyRefreshToken`, a leitura de `?spotify_refresh_token=`/`#`, os endereços casa/trabalho digitados, `saveDictatedAddress`, `getDriverContext`, o `driverContext` do `OrchestratorClient` e o tratamento de `save_address` em `voice-controller.ts`. Apaga do `localStorage` as chaves antigas (`finn.driverSettings` com token do Spotify e endereços) uma vez, no primeiro carregamento. Mantém as demais configurações (voz, wake word etc.).
- **Documentação:** `docs/ARCHITECTURE.md` (autenticação do PWA: sessão por convite, sem token do Spotify no aparelho) e `tests/MANUAL.md` (checklist abaixo).
- Testes obrigatórios (Vitest + jsdom/testing existente; sem rede real): convite válido grava token; 401, 429 (Retry-After), 503, rede; token legado guardado continua usado; 401 do orquestrador volta à tela; "Entrar com outro convite" sobrescreve; "Sair" apaga; conexão do Spotify (conectado, não conectado, dono, 403, erro); nenhuma gravação de refresh token ou endereço no `localStorage`; chaves antigas apagadas; nenhum segredo em `console.*`; falas locais de 429/503 acionadas.
- **Fora do escopo do `web`:** qualquer arquivo em `src/app/api/**`, `src/lib/driver/**`, `src/lib/auth.ts`, `src/lib/spotify/**` (servidor).

## Checklist manual do dono (iOS, preview) — decide a amarração ao navegador (opção b)

Em `tests/MANUAL.md`, com o PWA instalado na tela inicial (standalone) e contra um preview com Redis e `FINN_TOKEN_ENC_KEY`:
1. Resgatar um convite de teste no PWA; fechar e reabrir o app: segue logado.
2. "Conectar Spotify": a página do Spotify abre dentro ou fora do app? Depois do consentimento, o app volta sozinho ou é preciso abri-lo? O estado muda para "Conectado" ao voltar?
3. Cookies: depois do passo 2, o cookie de `finn_spotify_oauth_state` (modo dev) não importa em produção; anote apenas se o fluxo completa e **onde**.
4. Tocar uma música por voz com a conta conectada.
**Resultado** vira o insumo para decidir a opção (b) (cookie amarrando o callback ao navegador): só se o cookie sobreviver à ida e volta no iOS. Sem o teste, (b) continua fora.

## Roteiro de virada (do dono; eu preparo e executo o que for variável da Vercel)

1. Merge dos PRs #1 a #8 na ordem e deploy.
2. **Pepper de produção legível pelo script:** decisão pendente do dono (ver `ESTADO_ATUAL.md`); necessário para criar o convite do próprio dono em produção.
3. O dono cria um convite para si (`npm run invite:create -- --env production --confirm-production ...`), resgata no PWA novo e roda `npm run driver:list` para ver o próprio `driverId` (não é segredo).
4. Eu crio `FINN_OWNER_DRIVER_ID` em Production (e o dono reimplanta). Confirmar no carro: Spotify e endereços funcionando com a sessão nova.
5. Eu removo `FINN_LEGACY_TOKEN_ENABLED` de Production e o dono reimplanta. O `FINN_API_TOKEN` deixa de abrir qualquer coisa. Só então criar convites para outras pessoas (e adicionar os e-mails delas na lista do Spotify; limite de 25).

## Critério de pronto

- 5a e 5b: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` passam; nenhum teste faz chamada de rede.
- Relatório por entrega, no formato da Seção 5, com "Não verificado".
- Revisão: 5a = qa + security-review (área crítica). 5b = qa, e security-review uma vez sobre o diff combinado da entrega (token de sessão no aparelho, fluxo do Spotify, limpeza do `localStorage`).

## Fora de escopo

Amarração do callback ao navegador (depende do teste no iOS); rate limit por motorista nas rotas de IA (M3); firewall e cota do Upstash (A3); UI para editar endereços (etapa 3, lugares e aliases); idempotência do resgate (B4); PKCE.

## Decisões embutidas (provisórias, ajustáveis)

1. Os endereços digitados à mão na tela de Configurações saem; só o ditado por voz grava (no servidor, por motorista). A UI de endereços volta na etapa 3.
2. O token legado continua funcionando no PWA enquanto o servidor o aceitar; não há migração forçada no cliente. A virada acontece pelo roteiro acima.
3. `getOwnerDriverId()` mantém o id legado como dono provisório enquanto `FINN_LEGACY_TOKEN_ENABLED=1` e `FINN_OWNER_DRIVER_ID` não existir, para não cortar o Spotify do carro entre o deploy e a virada.

## Histórico de mudanças

- 2026-10-27: rascunho, após a decisão A1 (opção C).
- 2026-10-27: aprovado pelo dono, sem alterações.
