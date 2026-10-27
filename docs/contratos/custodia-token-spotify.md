# Contrato — custódia do refresh token do Spotify (etapa 1, entrega 4)

Status: **aprovado pelo dono em 2026-10-27** (com as 3 decisões embutidas). Base: [`identidade-e-perfil.md`](./identidade-e-perfil.md) e [`isolamento-por-motorista.md`](./isolamento-por-motorista.md). Fecha o M1 da entrega 3 (token de convidado sem vínculo com o `driverId`) e a exposição do token na URL, no `localStorage` e em cookie.

## Objetivo

Hoje o refresh token de cada motorista nasce no OAuth sem saber de quem é, passa pelo aparelho (`localStorage`, cookie `finn_spotify_rt` de 1 ano, query string `/?spotify_refresh_token=`) e volta no corpo de cada requisição. Esta entrega faz o servidor ser o único dono do token: o OAuth é iniciado por um motorista autenticado, o token é gravado **criptografado** sob o `driverId`, e nunca mais sai do servidor.

Esta é a última entrega de servidor exigida pelo C1. Convites em produção ainda esperam a entrega 5 (PWA com tela de convite e botão "Conectar Spotify").

## Invariantes

1. O refresh token nunca é gravado em claro (Redis, log, erro, resposta, HTML, URL, cookie, `localStorage`).
2. O token pertence ao `driverId` do **registro de estado do servidor**, nunca a cookie, corpo ou parâmetro de URL.
3. O servidor ignora qualquer refresh token vindo do cliente (corpo, `driverContext`, cookies `finn_spotify_*`), para todos, inclusive o dono.
4. Falha fechada: sem `FINN_TOKEN_ENC_KEY` válida, o fluxo de conexão e a leitura de tokens ficam desligados (nunca grava ou lê em claro). Dado indecifrável = "não conectado".
5. Só o dono (`LEGACY_OWNER_DRIVER_ID`) usa o `SPOTIFY_REFRESH_TOKEN` do servidor. Mantido da entrega 3.

## Modelo

- **Chave**: `FINN_TOKEN_ENC_KEY`, 64 hex (32 bytes), distinta por ambiente, validada como os outros segredos (`isAcceptableSecret`), diferente de `FINN_SESSION_SECRET`, `FINN_INVITE_PEPPER` e `FINN_A2A_TOKEN`.
- **Cifra**: AES-256-GCM, IV de 12 bytes aleatório por gravação, `AAD = finn:<env>:spotify:<driverId>` (um blob copiado para outro motorista ou ambiente não decifra). Formato `v1.<iv>.<ct>.<tag>` em base64url.
- **Chaves Redis** (prefixo `finn:<env>:`)
  - `spotify:<driverId>` → blob cifrado (sem TTL; apagado na revogação e na desconexão).
  - `oauth-state:<sha256(state)>` → `{ driverId, createdAt }`, TTL 600 s, **consumo atômico e de uso único** (`GETDEL`).
- **Cache de access token em memória** passa a ser por `driverId` (hoje é por refresh token). Refresh token rotacionado pelo Spotify é regravado cifrado.

## Rotas

- `POST /api/spotify/connect` (autenticado com `authorizeDriver`, rate limit por `driverId`, 10 por 600 s): cria o `state` (32 bytes aleatórios), grava o registro e devolve `{ url }` do consentimento do Spotify. O PWA navega até lá. Sem `FINN_TOKEN_ENC_KEY` válida: 503.
- `GET /api/spotify/callback` (público, mas só funciona com `state` válido): consome o registro (`GETDEL`), troca o `code`, cifra e grava o token sob o `driverId` do registro. Responde uma página "Spotify conectado, volte ao Finn" sem token, sem script que escreva `localStorage`, sem cookie de token e sem token na URL. `state` ausente, usado ou expirado = mesma página de erro genérica. Erros do Spotify e do Redis nunca vão para log com detalhe.
- `GET /api/spotify/connection` (autenticado): `{ connected: boolean }`.
- `DELETE /api/spotify/connection` (autenticado): apaga o blob. Idempotente.
- `GET /api/spotify/login`: fora de `NODE_ENV=development`, devolve página curta ("Use o botão Conectar Spotify dentro do Finn") com status 410 e não toca em Spotify nem Redis. Em desenvolvimento mantém o fluxo atual do dono para gerar `SPOTIFY_REFRESH_TOKEN` (redirect `127.0.0.1`), único lugar onde o token é exibido.
- `/api/orchestrator`: deixa de ler o cookie e `driverContext.spotifyRefreshToken`. `DriverContext` perde o campo `spotifyRefreshToken`.
- Revogação: `revokeDriver` e o script `driver:revoke` também apagam `spotify:<driverId>`. Novo script `driver:purge` (mesmas travas dos outros: `--env` obrigatório, `--confirm-production`) apaga `spotify:<id>` e `driver-addr:<id>`.

## Variáveis (só nomes e formato)

| Nome | Formato | Quando |
|---|---|---|
| `FINN_TOKEN_ENC_KEY` | 32 bytes hex, distinto por ambiente (`openssl rand -hex 32`) | esta entrega; o orquestrador cria na Vercel (autorização do dono) antes do smoke em preview |

**Trocar a chave invalida todos os tokens guardados**: os motoristas conectam o Spotify de novo (no máximo 25 usuários no modo de desenvolvimento do Spotify). Não há rotação com duas chaves nesta entrega.

## Critério de pronto

- `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` passam; nenhum teste faz chamada de rede.
- Testes obrigatórios:
  - cifra: ida e volta; blob adulterado (iv, ct, tag); AAD de outro motorista ou ambiente falha; chave errada falha; IV diferente a cada gravação;
  - o fake do Redis nunca vê o token em claro (espião sobre todas as gravações);
  - sem chave válida: `connect` 503, nada gravado, nada lido; chave igual a outro segredo rejeitada;
  - `state`: uso único (segundo uso falha), expirado falha, inexistente falha, consumo atômico sob corrida (um só vence), o token é gravado no `driverId` do registro mesmo com cookie ou parâmetro de outro motorista;
  - `connect` sem sessão = 401; rate limit por `driverId`; Redis fora = erro falável, sem log do SDK;
  - corpo, `driverContext` e cookies `finn_spotify_*` com token são ignorados no orquestrador (dono e convidado);
  - cache de access token isolado por `driverId` (dois motoristas em paralelo; mutação: cache por token do dono derruba teste);
  - motorista conectado usa o próprio token; não conectado ouve "Conecte seu Spotify"; dono segue no token do servidor; refresh token rotacionado é regravado cifrado;
  - desconexão e revogação apagam o blob; `driver:purge` apaga token e endereços;
  - callback: nenhuma resposta, cookie ou HTML contém o token; `GET /api/spotify/login` fora de desenvolvimento = 410 sem rede;
  - varredura de log: nenhum token, `state`, `code` ou blob em `console.*`; remover `err` de `src/lib/spotify/auth.ts:129` e do aviso de rotação.
- Relatório no formato da Seção 5, com "Não verificado".
- Revisão: qa e security-review (Opus), uma vez, sobre o diff estável. Área crítica.

## Execução

Branch `feat/spotify-token-custody`, empilhada sobre `feat/driver-isolation` (PR #5). Um PR com 3 commits: (1) cifra e armazenamento do token + cache por `driverId`; (2) `connect`, `callback`, `connection`, `login` e o orquestrador; (3) revogação, `driver:purge`, docs. `api` (Sonnet). Fora do escopo do agente: `src/components/**` e `src/lib/voice/**` (entrega 5).

## Fora de escopo

PWA (botão "Conectar Spotify", tela de convite, remoção do `localStorage` antigo e do campo de colar token): entrega 5. Até lá o PWA atual ainda envia o token no corpo e o servidor o ignora; um convidado só conecta o Spotify depois da entrega 5. O dono não é afetado (usa o token do servidor). Vínculo `spotify-index:<spotifyUserId>`, rotação de chave com duas chaves, rate limit por motorista nas rotas de IA (M3), firewall e cota do Upstash (A3).

## Decisões embutidas (provisórias, ajustáveis)

1. O OAuth é iniciado por `POST /api/spotify/connect` autenticado, e o dono do token vem do registro de `state` no Redis, não de cookie. É o que permite funcionar no PWA do iOS, onde cookie e `localStorage` do Safari e do app não se misturam.
2. O token do dono (`SPOTIFY_REFRESH_TOKEN`) só se gera rodando o app em desenvolvimento local (`127.0.0.1`), como hoje. Em produção `/api/spotify/login` fica desligado.
3. Trocar `FINN_TOKEN_ENC_KEY` obriga todos a reconectar o Spotify. Sem rotação com duas chaves por enquanto.

## Histórico de mudanças

- 2026-10-27: rascunho.
- 2026-10-27: aprovado pelo dono, sem alterações.
- 2026-10-27 (rodada 2 da entrega 4, após qa e security-review): decisão do dono sobre consent phishing (M1 do security-review, N4 do qa): **opção (a)**. Depois da troca do `code`, o callback consulta `GET /v1/me`, recusa a conta do dono e qualquer conta já ligada a outro motorista (`spotify-index:<spotifyUserId>` → `driverId`, gravação com `SET NX`) e a página de sucesso mostra o rótulo do perfil ligado. **Amarrar o callback ao navegador que iniciou o fluxo (cookie) fica para reavaliar na entrega 5**, depois de testar o PWA do iOS.
- 2026-10-27 (rodada 2): decisões técnicas do orquestrador: `connected` do dono = `Boolean(SPOTIFY_REFRESH_TOKEN)`; `connect` e `saveSpotifyRefreshToken` recusam `LEGACY_OWNER_DRIVER_ID` (403 na rota), `DELETE` do id legado segue funcionando; callback exige motorista existente e ativo; regravação de token rotacionado só se o blob ainda existir (`SET ... XX`); gate de desenvolvimento exige também `VERCEL_ENV` ausente ou `development`; `SPOTIFY_REDIRECT_URI` obrigatória quando `VERCEL_ENV=production`; timeout na troca do `code`.
