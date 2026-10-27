# Security review: entrega 4, custódia do refresh token do Spotify

- Escopo: `git diff cb805b5..HEAD` na branch `feat/spotify-token-custody` (commits da5ed4f, bc7e58c, 136f248) e o código que esse diff toca.
- Contrato: `docs/contratos/custodia-token-spotify.md`. Achados que esta entrega deveria fechar: M1 e a nota da query string do callback (`driver-isolation-security-review.md`), e C1 (`driver-session-routes-security-review.md`).
- O relatório do implementador (`docs/relatorios/spotify-token-custody-2026-10-27.md`) foi tratado como dado, não como prova. O que está marcado como **Fato** eu conferi no código, em HEAD (136f248). O que está marcado como **Hipótese** depende de comportamento externo ou de cenário que não reproduzi.
- Revisor: security-review (Opus), 2026-10-27. **Esta revisão não aprova o merge: ela relata.**

## Resumo

| Severidade | Qtde | Itens |
|---|---|---|
| Crítico | 0 | — |
| Alto | 0 | — |
| Médio | 2 | M1, M2 |
| Baixo | 6 | B1 a B6 |
| Informativo | 4 | I1 a I4 |

- **M1 anterior fechado (Fato).** O servidor não lê mais o token do corpo, do `driverContext` nem dos cookies `finn_spotify_*` (`src/app/api/orchestrator/route.ts:27-30`). `whoIs` passa só o `driverId` (`src/agents/spotify/tools.ts:10-12`). O token de quem não é o dono vem só do cofre, pelo `driverId` da sessão (`src/lib/spotify/auth.ts:133-150`).
- **Nota da query string fechada (Fato).** O callback de produção não redireciona, não grava cookie, não tem script e não põe o token em URL nem em HTML (`src/lib/spotify/connect.ts:72-118`; `src/lib/spotify/oauth.ts:33-61`).
- **C1 continua fechado, inclusive no caminho de erro (Fato).** Para quem não é o dono não existe fallback para `SPOTIFY_REFRESH_TOKEN` (`auth.ts:146-150`). O log de `customErr` e de `err` saiu (`auth.ts:93-97,100-105,157-161`).
- **Novo risco principal (M1 desta revisão).** O `state` prende o token ao motorista que **iniciou** o fluxo, não a quem o **completa**. Um convidado mal-intencionado pode mandar a URL de consentimento para outra pessoa da lista do Spotify (o dono, por exemplo). Se ela aceitar, a conta Spotify dela fica ligada ao `driverId` do atacante.
- **Comandos que rodei:** `npx vitest run src/lib/spotify src/lib/driver src/app/api/spotify src/app/api/orchestrator src/agents/spotify tests/scripts/admin-cli.test.ts tests/acceptance/driver-isolation.test.ts src/orchestrator`. Resultado: 16 arquivos e 325 testes passaram, 0 falharam. Não rodei o lote completo (`npm test && npm run typecheck && npm run lint`) nem o `build`.

---

## Médio

### M1. Consent phishing: o callback liga ao motorista que iniciou o fluxo a conta Spotify de quem consentiu, e não confere se essa conta já é de outro (Fato no código; exploração, Hipótese)

- **Fato:**
  - `handleConnect` devolve ao cliente autenticado a URL completa de consentimento, com o `state` dentro (`src/lib/spotify/connect.ts:50-54`).
  - `handleCallback` é público. Ele grava o token sob o `driverId` do registro de `state` (`connect.ts:97,108`). Nada liga a conclusão do fluxo ao navegador ou aparelho que o iniciou: não há cookie nem segredo do iniciador. Isso é uma decisão do contrato (decisão 1, por causa do PWA no iOS).
  - Não existe vínculo `spotifyUserId → driverId` (`spotify-index` está fora de escopo). Também não há checagem de que a conta Spotify do dono não seja gravada para um convidado.
  - A página de sucesso não diz a qual perfil o Spotify foi ligado (`connect.ts:114-117`).
- **Cenário (Hipótese):**
  1. O convidado A chama `POST /api/spotify/connect` e recebe `{ url }`.
  2. A manda o link ao dono (ou a outro motorista da lista de até 25 usuários do Spotify) com algo como "toca aqui pra ativar o Spotify do Finn".
  3. A vítima vê a tela legítima de consentimento do app "Finn" (`show_dialog=true`) e aceita.
  4. O refresh token da vítima fica cifrado em `spotify:<driverId de A>`. Daí em diante A toca, pausa e lê as playlists privadas da vítima (escopos em `src/lib/spotify/auth.ts:8-14`). Isso dura até a vítima tirar o acesso do app no Spotify, e ela não tem como perceber pelo Finn.
- **Por que médio:** exige um convidado mal-intencionado, engenharia social, uma vítima na allowlist do Spotify e consentimento explícito dentro de 600 s (`OAUTH_STATE_TTL_SECONDS`). Não é um bypass técnico do isolamento. Mas o resultado é "dado de um motorista (ou do dono) alcançável por outro".
- **Correção sugerida (escolha do dono):**
  - Depois do `exchangeAuthorizationCode`, chamar `GET /v1/me` com o access token e pegar o `id` da conta Spotify. Recusar a gravação quando esse `id` for o da conta do dono (por exemplo, numa variável `SPOTIFY_OWNER_USER_ID`, só o nome) ou já estiver ligado a outro `driverId`. É o `spotify-index` do contrato de identidade, com unicidade (`SET NX`).
  - Na página de sucesso, mostrar o rótulo do perfil ligado (com `escapeHtml`): "Spotify conectado ao perfil «rótulo»". Incluir também um aviso: "não foi você quem pediu? Avise o dono".
  - Teste: um callback com o `state` de A e uma conta Spotify já ligada a B (ou à do dono) não grava nada.
- **Não verificado:** se `/v1/me` devolve `id` só com os escopos atuais. Pela documentação pública, sim; não testei.

### M2. O callback público gasta 1 comando Redis por requisição anônima, sem limite por IP nem global: é uma nova superfície do A3 (Fato no código; impacto, Hipótese)

- **Fato:**
  - Qualquer `GET /api/spotify/callback?state=<43 caracteres base64url>` com a chave de cifra válida faz um `GETDEL` (`connect.ts:97`; `src/lib/driver/upstash-store.ts:229-236`).
  - Um `state` com formato inválido não toca no Redis (`src/lib/driver/store.ts:158-161`), e sem a chave também não (`connect.ts:84`). Mas um atacante gera formato válido à vontade.
  - Não há rate limit nessa rota.
- **Impacto (Hipótese):** é o mesmo do A3 e do M2 da revisão anterior. Um atacante distribuído esgota a cota do Upstash, e aí `authorizeDriver` responde 503 a todos os motoristas. Adivinhar um `state` vivo é inviável (256 bits), então não há queima de `state` alheio nem enumeração.
- **Correção sugerida:**
  - Uma regra de rate limit por IP no firewall da Vercel para `/api/spotify/callback` (ação do dono, junto com o A3).
  - Opcional no código: assinar o `state` com HMAC (por exemplo `state = rand32 || HMAC(chave, rand32)`) e conferir a assinatura antes de tocar no Redis. Assim, `state` forjado custa zero comandos.
- **Não verificado:** a cota e o plano atuais do Upstash, e as regras de firewall existentes.

---

## Baixo

### B1. Corridas que recriam o blob depois de desconexão, revogação ou reconexão (Fato no código; frequência, Hipótese)

- **Rotação:** `refreshFor` lê o token, chama o Spotify e, se veio um token rotacionado, chama `saveSpotifyRefreshToken` sem checar se o blob ainda é o mesmo (`src/lib/spotify/auth.ts:152-162`). O `SET` é incondicional (`upstash-store.ts:206-210`). Isso abre três corridas:
  - `DELETE /api/spotify/connection` ou `driver:revoke`/`driver:purge` durante um refresh em voo: o blob volta a existir.
  - Uma reconexão com outra conta durante um refresh em voo da conta antiga: o blob volta para a conta antiga.
  - Duas instâncias renovando ao mesmo tempo: a última gravação vence. Se o Spotify invalidar o token anterior, uma delas guarda um token morto e o motorista ouve "Perdi o acesso" (Hipótese).
- **Callback:** a rota não confere o status do motorista. Um `state` criado antes de `driver:revoke` (até 600 s antes) ainda grava o token de um motorista já revogado (`connect.ts:101-108`).
- **Impacto:** fica tudo dentro do mesmo `driverId`. A sessão revogada recebe 401, então o token é inalcançável. Mesmo assim, viola "revogação e desconexão apagam o blob" e retém uma credencial de terceiro sem prazo.
- **Correção sugerida:**
  - Gravar o token rotacionado com compare-and-set (EVAL: `if GET(k) == blobLido then SET(k, novo)`), passando o blob lido em `loadSpotifyRefreshToken`.
  - No callback, conferir `getDriver(driverId)?.status === "active"` antes de gravar.
  - Testes: (a) um DELETE entre o load e o save não recria o blob; (b) um callback depois da revogação não grava.
- **Não verificado:** se o Spotify rotaciona o refresh token no fluxo authorization code com client secret. O habitual é só no fluxo PKCE.

### B2. Depois de desconectar, purgar ou reconectar, o access token continua valendo em outras instâncias até cerca de 59 min (Fato; limitação já declarada)

- `evictSpotifyAccessToken` só limpa a memória da instância que atendeu (`auth.ts:44-48`; `connect.ts:112,158`). O TTL do cache é `expires_in - 60 s` (`auth.ts:128-130`).
- Na revogação a sessão é barrada na hora, então não há impacto entre motoristas. Na reconexão com outra conta, a instância antiga segue operando a conta anterior do **mesmo** motorista por até 1 h.
- **Correção sugerida:** guardar no Redis uma "geração" por motorista, incrementada em connect/disconnect/purge, e conferir antes de usar o cache. Ou aceitar o risco e registrar em `docs/ESTADO_ATUAL.md`.

### B3. A `redirect_uri` cai para a origem da requisição quando falta `SPOTIFY_REDIRECT_URI` (Fato; exploração, Hipótese)

- `redirectUriFor` usa `process.env.SPOTIFY_REDIRECT_URI` ou, na falta dele, `new URL(request.url).origin` (`src/lib/spotify/oauth.ts:12-14`). Ela é usada em `connect` e no callback (`connect.ts:54,105`), e lê `process.env` em vez de `deps.env`.
- O Spotify só aceita URIs cadastradas, então um `Host` forjado leva a erro, e não a open redirect (Hipótese, baseada no comportamento documentado do Spotify).
- **Correção sugerida:** fora de `development`, exigir `SPOTIFY_REDIRECT_URI` (sem ela, `connect` responde 503). Passar o `env` de `deps` para `redirectUriFor`.

### B4. PKCE ausente (Fato; necessidade, avaliação)

- O cliente é confidencial (client secret só no servidor) e o `state` é de uso único, ligado a um registro do servidor. Por isso PKCE **não é necessário** contra interceptação simples.
- Sem PKCE, sobra a injeção de `code`. Quem conseguir um `code` ainda não resgatado da vítima consegue trocá-lo usando o **próprio** `state` e ligar a conta da vítima ao próprio `driverId`. Isso só acontece quando o callback falha antes da troca (503 por Redis ou chave): o `code` fica válido e está na URL, no histórico e, por Hipótese, nos logs da Vercel.
- **Correção sugerida:** é barata. Gerar um `code_verifier` em `createOAuthState`, guardar no registro de `state` e mandar o `code_challenge` (S256) na URL e o `code_verifier` na troca.

### B5. Resíduos do fluxo antigo que este diff não limpa (Fato no código; exposição, Hipótese)

- O cookie `finn_spotify_rt` (`HttpOnly`, um ano), gravado pelo callback antigo, nunca é expirado pelo servidor. Busquei `finn_spotify` em `src` e só existe `finn_spotify_oauth_state`. O cookie segue indo em toda requisição ao domínio. É ignorado, mas o valor continua no aparelho.
- O PWA ainda lê `?spotify_refresh_token=` da URL, guarda no `localStorage` e manda no corpo (`src/lib/voice/driver-settings.ts:30-46,97-101`; `src/lib/voice/orchestrator-client.ts:65`). Isso é escopo da entrega 5, e o servidor ignora (Fato).
- Se o dono usou o fluxo antigo em produção, o refresh token dele passou por query string, histórico, `localStorage` e cookie (Hipótese: não sei se usou).
- **Correção sugerida:**
  - Uma resposta do servidor com `Set-Cookie: finn_spotify_rt=; Max-Age=0; Path=/` (por exemplo, no callback novo e na rota de sessão).
  - Antes de convites, o dono revoga o acesso do app na conta Spotify dele, gera um `SPOTIFY_REFRESH_TOKEN` novo pelo fluxo de desenvolvimento e atualiza a variável.
  - A entrega 5 remove a leitura de URL e o campo do `localStorage`.

### B6. Corpo de erro da API do Spotify ainda vai para log via `cause` (Fato; sensibilidade, Hipótese)

- `api.ts:93` mantém `new UserFacingError(speechFor(err), { cause: err })`. `SpotifyHttpError` leva na mensagem a URL e até 300 caracteres do corpo da resposta (`src/lib/spotify/api.ts:17`).
- Se esse erro subir sem tratamento, `src/lib/agent-runtime.ts:165` e `src/orchestrator/orchestrate.ts:67` fazem `console.error(..., err)`, e o Node imprime a cadeia `cause`. Esses dois pontos já existiam antes do diff.
- O corpo não leva o token (o Bearer vai no cabeçalho). Pode levar ids de playlist e mensagens do Spotify.
- `api.ts:92` também loga `err.reason`, que é texto vindo do Spotify.
- **Correção sugerida:** tirar o corpo da mensagem de `SpotifyHttpError` (manter só `status` e `reason` de uma lista fechada) e nos dois `console.error` logar só `err.name`.

---

## Informativo

- **I1. Fluxo de desenvolvimento do dono.**
  - `connect.ts:79-82` compara o cookie com o `state` usando `===`, que não é de tempo constante. Só vale com `NODE_ENV=development`, e o atacante precisaria plantar o cookie. Não é explorável.
  - O cookie `finn_spotify_oauth_state` não é apagado depois do uso. Ele expira em 600 s.
- **I2. O dono pode chamar `connect`.** Isso grava um blob que nunca é lido (`auth.ts:148-150`). Para o dono, `GET /api/spotify/connection` responde `false` (decisão em aberto no relatório). O blob pode ser removido com `driver:purge`.
- **I3. `MemoryDriverStore.purgeDriverData` só apaga o blob** (`src/lib/driver/memory-store.ts:127-129`). Só afeta dev e testes. O script usa sempre `UpstashDriverStore`, que apaga `spotify:<id>` e `driver-addr:<id>` (`upstash-store.ts:239-245`).
- **I4. `driver:revoke` de um motorista já revogado roda `revokeDriver` sem pedir confirmação** (`scripts/lib/admin-cli.mjs:212-216`). É idempotente e só apaga o blob. Aceitável.

---

## Verificação por item pedido

### (1) Criptografia e chave

- **AES-256-GCM: Fato** (`src/lib/spotify/token-crypto.ts:36-71`).
  - O IV tem 12 bytes de `randomBytes` a cada gravação, nunca derivado nem reaproveitado (linha 38).
  - A tag tem 16 bytes, fixada em `authTagLength`, com tamanho conferido e verificação feita pelo GCM em `final()`, não à mão (linhas 39, 62-66).
  - A AAD é `finn:<env>:spotify:<driverId>`, igual à chave Redis (`token-vault.ts:29-32`).
  - O formato `v1` é estrito:
    - exatamente 4 partes;
    - base64url canônico (`decodeCanonical` reencoda e compara);
    - tamanho máximo de 4200;
    - ciphertext com pelo menos 1 byte.
  - O store também valida o formato com regex antes de gravar (`store.ts:150,164-166`). Texto em claro não passa. Confirmei que `automaticDeserialization:false` (`redis-client.ts:20`) faz o blob e o JSON do `state` voltarem como string.
- **Sem oráculo: Fato.** Qualquer falha vira `null`, sem lançar erro e sem dizer o motivo (`token-crypto.ts:52-70`). Para o cliente, "adulterado", "AAD errada" e "ausente" são o mesmo "não conectado" (`connect.ts:141-143`).
- **Chave: Fato** (`token-crypto.ts:21-30`).
  - `isAcceptableSecret` exige 64 hex com pelo menos 8 caracteres distintos (`session-token.ts:20-22`).
  - A chave é recusada se for igual, sem diferenciar maiúsculas, a `FINN_SESSION_SECRET`, `FINN_INVITE_PEPPER`, `FINN_A2A_TOKEN`, `FINN_A2A_TOKEN_NEXT` ou `FINN_API_TOKEN`.
  - `assertKey` confere 32 bytes.
  - Que a chave seja distinta **por ambiente** não dá para garantir no código. Isso é procedimento do dono.
- **Sem chave: falha fechada. Fato.**
  - `connect` responde 503 antes de tocar no Redis (`connect.ts:36`).
  - O callback responde 503 sem consumir o `state` (`connect.ts:84`).
  - `loadSpotifyRefreshToken` lança erro antes de ler o Redis (`token-vault.ts:57`). Quem não é o dono ouve "não está configurado".
  - `DELETE` continua funcionando, o que é correto.

### (2) Fluxo OAuth

- **`state` de 32 bytes: Fato** (`store.ts:153-156`). No Redis fica só o `sha256` dele (`upstash-store.ts:221-227`).
- **TTL de 600 s: Fato.** O TTL vem do `EX` e há uma checagem redundante de `createdAt` (`store.ts:169-180`).
- **Uso único com `GETDEL`: Fato** (`upstash-store.ts:233`).
- **`driverId` só do registro: Fato** (`connect.ts:97,108`). O callback não lê cookie, corpo nem parâmetro de `driverId`.
- **Login CSRF / fixation:** um atacante não consegue ligar a conta **dele** ao perfil da vítima, porque o `state` é dele e o token vai para ele mesmo (Fato). O caminho inverso, consent phishing, é o M1.
- **Callback público:**
  - DoS de Redis: M2.
  - Queimar o `state` de outra pessoa ou enumerar `state`: inviável (256 bits).
  - Open redirect: não há, porque não redireciona (Fato).
  - XSS: em produção a página não reflete nenhuma entrada. Em dev, o `error` passa por `escapeHtml`. A CSP é `default-src 'none'` (`oauth.ts:59`) (Fato).
  - O `error=` do Spotify não é refletido em produção (Fato, `connect.ts:102`).
- **Referer, histórico e logs:**
  - `Referrer-Policy: no-referrer`, sem sub-recursos e com `no-store` (Fato).
  - `code` e `state` ficam no histórico e, por Hipótese, nos logs da Vercel. Os dois são de uso único e o `code` exige o client secret. Ver B4 para o caso de falha antes da troca.
- **PKCE:** não é necessário para cliente confidencial, mas é recomendado como defesa em profundidade (B4).
- **Escopos:** os quatro listados são o mínimo para tocar, pausar, listar aparelhos e listar playlists (Fato, `auth.ts:8-14`). `user-read-playback-state` expõe o que está tocando e os aparelhos.

### (3) Refresh token nunca em claro

- **Fato:**
  - Redis: só o blob `v1`, com trava de formato no store.
  - Log: nenhum `console.*` com token, `state`, `code` ou blob. Revisei todos os `console.*` em `src/lib/spotify`, `src/app/api/spotify`, `src/agents/spotify`, `src/lib/driver` e na rota do orquestrador.
  - Erro: frases fixas em `UserFacingError`, e `Invalid token input` sem valor.
  - Resposta: `{ connected }` e `{ url }`, sem token.
  - HTML, cookie, `localStorage` e URL: não aparece no caminho de produção.
- **Exceção prevista no contrato:** a página de desenvolvimento do dono (`connect.ts:121-133`).
- **Ressalvas:** resíduos do fluxo antigo (B5) e o corpo de erro da API em `cause` (B6, que não tem token).

### (4) Tokens do cliente ignorados; não dono sem acesso a `SPOTIFY_REFRESH_TOKEN`

- **Fato:**
  - O `driverContext` é reduzido a `{}` (`orchestrator/route.ts:30`). Cookies não são lidos.
  - `/api/agents/[agent]` e o A2A não repassam `driverContext` (busquei `driverContext` em `src`, fora de `src/lib/voice` e `src/components`).
  - `refreshFor` usa o env só quando `driverId === LEGACY_OWNER_DRIVER_ID`, e esse `driverId` sai de `authorizeDriver`. `ownerRotatedRefreshToken` só é lido nesse mesmo ramo (`auth.ts:146-155`).
- **Caminhos que restam até a identidade do dono:** o token legado (A1) e o consent phishing (M1), que não usa o env, mas pode pegar a conta Spotify do dono.

### (5) Cache, revogação, rotação

- **Cache por `driverId`: Fato** (`auth.ts:31-32,186-200`). O teto é de 200 motoristas, com expulsão.
- **Instâncias, desconexão e reconexão:** B2.
- **Rotação e corrida na regravação:** B1.

### (6) Revogação, `driver:purge`, scripts

- **`revokeDriver` apaga o blob: Fato** (`upstash-store.ts:190-196`). São dois comandos, não atômicos. Se o segundo falhar, o script mostra "Redis indisponível" e rodar de novo resolve, porque é idempotente (`admin-cli.mjs:212-216`).
- **`driver:purge`: Fato.**
  - Herda as travas: `--env` obrigatório, `--confirm-production`, `--yes` sem TTY e confirmação interativa (`admin-cli.mjs:153-156,224-231`).
  - Apaga `spotify:<id>` e `driver-addr:<id>` num único `DEL` (`upstash-store.ts:239-245`).
  - A saída não tem segredo e os erros são genéricos (`admin-cli.mjs:243-258`).
- **`--env-file`:** só confere se o arquivo existe e carrega com `process.loadEnvFile`, sem imprimir valores (Fato, `admin-cli.mjs:158-166`).
- **Dívida anterior:** `revokeDriver` continua sem apagar `driver-addr:<id>` (só o purge apaga).

### (7) Rate limit e custo de Redis

- **`connect`: Fato.** 10 por 600 s por `driverId`, no Redis (`connect.ts:23,43-49`), com a chave `ratelimit:spotify-connect:<driverId>` escopada por motorista. Cada chamada custa 1 EVAL e 1 SET, e a rota exige autenticação.
- **Callback anônimo:** M2.

### (8) `GET /api/spotify/login` e o fluxo do dono

- **Fato:**
  - Fora de `NODE_ENV=development` a rota responde 410 com uma página fixa, sem tocar em Spotify nem Redis (`src/app/api/spotify/login/route.ts:17-19`).
  - Na Vercel (preview e produção) o `NODE_ENV` é `production` (Hipótese padrão da plataforma; não verifiquei).
  - Em dev o `state` tem 32 bytes em hex, e o cookie é `HttpOnly`, `SameSite=Lax`, `Path=/api/spotify`, com 600 s.
  - A página que mostra o token tem CSP, `no-store` e `no-referrer`, e não tem script nem cookie (`connect.ts:127-130`).
- **Observação:** o procedimento manda cadastrar a URI `http://127.0.0.1:<porta>` no mesmo app do Spotify usado em produção. É prática comum, com risco desprezível. Um app separado para dev também resolveria.

### (9) O que ainda impede convites em produção

1. **Entrega 5:** sem o botão "Conectar Spotify" no PWA, o convidado não conecta. Ela também precisa remover a leitura de `?spotify_refresh_token=`, o `localStorage` e o campo de colar token (B5).
2. **M1 desta revisão:** decidir a mitigação do consent phishing (no mínimo, recusar a conta Spotify do dono para quem não é o dono e mostrar o perfil na página de sucesso) antes de haver convidados.
3. **A1:** o token legado (`FINN_API_TOKEN`, ativo em Production) vira o dono e não é revogável por motorista. Fica até o PWA novo (`ESTADO_ATUAL.md:33`).
4. **A3 + M2:** não há regra de firewall nem alerta no Upstash. Agora há mais uma rota anônima que gasta Redis (`ESTADO_ATUAL.md:69`).
5. **M3:** não há limite por motorista nas rotas de IA (`ESTADO_ATUAL.md:72`).
6. **Provisionamento do dono:**
   - `FINN_TOKEN_ENC_KEY` distinta por ambiente;
   - `SPOTIFY_REDIRECT_URI` em cada ambiente (B3);
   - cada convidado na allowlist do app Spotify (modo de desenvolvimento, até 25 usuários);
   - rotação do `SPOTIFY_REFRESH_TOKEN` do dono se ele já passou pelo fluxo antigo (B5).
7. **Processo:**
   - o qa deste diff;
   - o lote completo, que não rodei;
   - o smoke em preview;
   - a remoção do `DriverContext.spotifyRefreshToken` deprecado na entrega 5.
8. **Linha 72 do `ESTADO_ATUAL.md`** ("`auth.ts:129` faz `console.warn(..., err)`") pode ser marcada como resolvida: o log saiu (Fato, `auth.ts:155,160`).

---

## Não verificado

- **Sistemas reais.** Nenhuma chamada a Upstash, Vercel ou Spotify reais. Ficaram sem confirmação:
  - a resposta real de `GETDEL` e `SET ... EX` no Upstash;
  - se os logs da Vercel guardam a query string do callback;
  - o `NODE_ENV` efetivo em preview e produção;
  - se o Spotify rotaciona o refresh token nesse fluxo;
  - se `/v1/me` devolve `id` com os escopos atuais.
- **Lote completo.** Rodei só os 16 arquivos afetados (325 testes passaram). Não rodei `npm test`, `typecheck`, `lint` nem `build`. Os números do relatório do autor (782 testes) não foram reproduzidos.
- **Mutações.** Não refiz as mutações declaradas no relatório (cache por token do dono, `GET` no lugar de `GETDEL` etc.).
- **PWA.** Não abri o PWA nem rodei `next dev` com o fluxo do dono.
- **`.env*`.** Não abri nenhum `.env*`. O diff do `.env.example` mostra só o comentário e `# FINN_TOKEN_ENC_KEY=` vazio. Não sei se `FINN_TOKEN_ENC_KEY` existe em algum ambiente.
- **`ESTADO_ATUAL.md`.** Li só as linhas sobre A1, A3, M3 e convites, não o arquivo inteiro.
