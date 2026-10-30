# Security review: entrega 3, isolamento por motorista (`feat/driver-isolation`)

- Escopo: `git diff feat/a2a-own-token..HEAD` (commits 87e041c, 750de0c, 4f8fdb9) e o código que esse diff alcança.
- Contrato: `docs/contratos/isolamento-por-motorista.md`. Achados que esta entrega deveria fechar: C1 (`driver-session-routes-security-review.md`) e M1 com 6 pontos (`a2a-own-token-security-review.md`).
- O relatório do implementador foi tratado como dado, não como prova. Tudo o que está marcado como Fato foi conferido no código, em HEAD.
- Revisor: security-review (Opus), 2026-10-27. **Esta revisão não aprova o merge: ela relata.**

## Resumo

| Severidade | Qtde | Itens |
|---|---|---|
| Crítico | 0 | — |
| Alto | 0 | — |
| Médio | 2 | M1, M2 |
| Baixo | 6 | B1 a B6 |

- **C1 está fechado no código (Fato).** Um `driverId` diferente de `LEGACY_OWNER_DRIVER_ID` não alcança `SPOTIFY_REFRESH_TOKEN`, os caches de módulo do dono nem `WAZE_SAVED_ADDRESSES`, por nenhum caminho: principal, de erro ou de fallback. O livro global saiu.
- **Os 6 pontos do M1 anterior estão atendidos no código (Fato).** As ressalvas estão em M2, B1, B2 e B3.
- **Risco que sobra para convidados.** A credencial do Spotify que o servidor usa para um convidado continua sendo "o que vier no corpo ou no cookie". Ela não está ligada ao `driverId` (M1). O contrato aceita isso até a entrega 4, mas o pressuposto "o cookie é do motorista" é falso num aparelho compartilhado.
- **Comandos rodados por mim:** `npx vitest run` sobre os 8 arquivos afetados (`src/lib/spotify/isolation.test.ts`, `src/app/api/orchestrator/route.test.ts`, `src/app/api/agents/[agent]/route.test.ts`, `src/lib/a2a-guard.test.ts`, `src/lib/waze/address-book.test.ts`, `src/agents/waze/*`, `src/lib/auth.test.ts`): 8 arquivos e 141 testes passaram, 0 falharam. Não rodei o lote completo (`npm test && npm run typecheck && npm run lint`).

---

## Médio

### M1. O refresh token do Spotify usado para um convidado não está ligado ao `driverId`: em aparelho compartilhado, B opera o Spotify de A, ou o do dono (Fato no código; cenário de exploração, Hipótese)

- **Origem do token.** `src/app/api/orchestrator/route.ts:32-37` pega o token de `driverContext.spotifyRefreshToken` do corpo ou, na falta dele, dos cookies `finn_spotify_token` e `finn_spotify_rt`. Esse token segue para o agente junto com o `driverId` da sessão (`route.ts:40-45,52`). Nada confere que esse token pertence a esse `driverId`.
- **Uso no servidor.** `src/lib/spotify/auth.ts:190-192`: para quem não é o dono, o servidor usa qualquer token apresentado. O próprio teste confirma que até o **valor** de `SPOTIFY_REFRESH_TOKEN`, se apresentado por um convidado, funciona; ele só não toca os caches do dono (`src/lib/spotify/isolation.test.ts:73`). Na prática, ter o token já dá a autoridade.
- **O cookie.** `src/app/api/spotify/callback/route.ts:117-120` grava `finn_spotify_rt` com `HttpOnly` e `Max-Age=31536000`: um ano, preso ao navegador e não ao motorista. O JavaScript do PWA não consegue apagá-lo, e não existe rota de logout que o limpe (Fato: não encontrei `Max-Age=0` para `finn_spotify_rt`).
- **Cenário.** O motorista A (ou o dono) conecta o Spotify no aparelho. Depois o motorista B entra no mesmo navegador com o próprio token de sessão. As chamadas de B chegam com o cookie de A, e B toca, pausa e lista as playlists de A. Se quem conectou foi o dono e o cookie tem o mesmo valor de `SPOTIFY_REFRESH_TOKEN`, B usa a conta do dono. Isso não passa pelo caminho do env, e por isso C1 continua fechado no sentido literal.
- **Por que médio e não alto.** O ataque exige aparelho ou navegador compartilhado. O contrato aceita explicitamente o token "dele até a entrega 4" (`isolamento-por-motorista.md:24`). Não existe CSRF: a rota exige `Authorization: Bearer`, que um site de terceiros não consegue mandar sem preflight.
- **Correção sugerida:**
  - Na entrega 4, guardar o refresh token no servidor sob `finn:<env>:driver-spotify:<driverId>`, cifrado, e parar de aceitar o token vindo do corpo ou do cookie.
  - Até lá, e antes de qualquer convite: quando `driverId !== LEGACY_OWNER_DRIVER_ID`, ignorar o cookie e aceitar só o corpo. Criar também uma rota de logout ou troca de motorista que limpe `finn_spotify_rt` com `Max-Age=0`.
  - Um teste de rota: convidado com cookie e sem corpo não usa o cookie.
- **Não verificado:** como o PWA se comporta na troca de sessão (se limpa `finn.driverSettings` no `localStorage`). Não abri o PWA.

### M2. Quando ligado, o A2A gasta comandos Redis sem autenticação: é uma nova superfície do A3 (Fato no código; impacto, Hipótese)

- Em `src/lib/auth.ts:110` cada POST faz um `GET` no Redis antes de olhar o Bearer. Em `auth.ts:117` cada falha faz mais um `EVAL` (INCR+EXPIRE). Depois do 429, cada pedido ainda custa um `GET`.
- Não existe balde global, só por IP. Um atacante distribuído ou com muitos /64 de IPv6 gasta a cota do Upstash sem credencial nenhuma.
- Com a cota esgotada, `authorizeDriver` (`auth.ts:171-178`) devolve 503 a **todos** os motoristas. É o mesmo efeito do A3 da entrega 2 (`ESTADO_ATUAL.md:67`), que continua aberto.
- **Hoje o risco é zero (Fato):** sem `FINN_A2A_TOKEN` válido, `guardA2A` responde 503 antes de tocar o store (`auth.ts:100-101`, teste em `a2a-guard.test.ts:130`).
- **Correção sugerida:**
  - Responder 401 **sem ir ao Redis** quando o Bearer estiver ausente ou fora do formato `^[0-9a-f]{64}$`. O formato é público (procedimento, linha 7) e não é uma comparação de segredo, então isso não contraria "limitador antes de comparar o Bearer". Isso corta o custo do scanner comum.
  - Antes de criar `FINN_A2A_TOKEN`: uma regra de rate limit no Firewall da Vercel que cubra também `/api/agents/*` e um alerta de uso no Upstash. São ações do dono, as mesmas do A3.
- **Não verificado:** a cota real do plano do Upstash e o custo por comando do `EVAL`.

---

## Baixo

### B1. Bloqueio do cliente A2A legítimo por IP compartilhado e dependência do cabeçalho de IP (Fato no código; spoof, Hipótese)

- O 429 sai antes da comparação, mesmo para o segredo certo (`auth.ts:110`, teste em `a2a-guard.test.ts:47`). Quem divide o IP com o cliente A2A (NAT, CGNAT, mesma nuvem) o bloqueia por 10 min com 10 falhas. O procedimento registra isso (`rotacao-token-a2a.md:29`).
- O IP vem de `x-vercel-forwarded-for`, depois `x-real-ip`, depois `x-forwarded-for` (`src/lib/client-ip.ts:27`). Que a Vercel sobrescreve esses cabeçalhos é **Hipótese** (`client-ip.ts:6-13`).
  - Fora da Vercel, ou com outro proxy na frente (por exemplo Cloudflare), o atacante escolhe o balde. Assim ele pode contornar o limite ou mirar o IP do cliente legítimo para bloqueá-lo.
  - Contornar o limite não torna a adivinhação viável: o segredo tem 256 bits e a comparação é em tempo constante (Fato: `auth.ts:13-15,54-61`; o laço sem saída antecipada esconde quantos segredos casaram).
- `peek` e `increment` não são atômicos (`auth.ts:110-117`): N pedidos paralelos passam do teto em até N. O autor já registrou isso, e o impacto é desprezível com 256 bits.
- **Correção sugerida (decisão do dono):** aceitar e manter documentado. Se houver um cliente A2A real com IP fixo, uma lista de IPs permitidos no Firewall da Vercel resolve os dois lados.

### B2. Sinais de estado sem autenticação: 503 desligado, 503 Redis, 401 e 429 (Fato)

- "A2A endpoint disabled" (`auth.ts:25`) e "O Finn está indisponível agora" (`auth.ts:136`, devolvido em `auth.ts:112,119`) são 503 com corpos diferentes. Quem não tem credencial descobre se o A2A está ligado e se o Redis está de pé. O 429 revela que o IP está bloqueado.
- Nenhum valor é ecoado e nada é logado além da linha única, sem valor, em `auth.ts:23` (Fato). É o mesmo bit já aceito no B1 da revisão do A2A.
- **Correção sugerida:** opcional. Usar o mesmo corpo nos dois 503.

### B3. Segredo A2A sem expiração e sem trilha de uso; quem o tem reescreve, de forma persistente, a casa e o trabalho do dono (Fato)

- Um acerto não é contado nem logado (`auth.ts:115`). Se o segredo vazar, o dono não tem como perceber o uso.
- O A2A roda como dono (`src/lib/a2a-server.ts:78`) e aceita uma `continuation` do cliente (`a2a-server.ts:65-70`). Basta mandar `{ pendingLabel: "casa" }` junto com um texto qualquer: `createNavigateTo` grava o valor em `driver-addr:<dono>` (`src/agents/waze/tools.ts:68-78`).
  - Antes desta entrega a escrita ia para memória da instância. Agora fica no Redis e sobrevive a deploys.
  - Efeito: o "me leva pra casa" do dono passa a abrir uma rota escolhida pelo atacante.
- Isso está de acordo com a decisão "`FINN_A2A_TOKEN` é credencial do dono" (contrato, linha 45), mas o procedimento não fala desse efeito.
- **Correção sugerida:**
  - Criar um contador sem valores de acertos por dia (por exemplo `ratelimit:a2a-ok:<yyyymmdd>`) ou uma linha de log sem valores por acerto.
  - Em "Revogar" (`rotacao-token-a2a.md:23-25`), acrescentar: conferir e, se preciso, refazer casa e trabalho do dono.
  - Opcional: o A2A não aceitar `pendingLabel`, isto é, não gravar endereço por A2A.

### B4. A regra "ambiente relaxado" é mais frouxa que a definição de produção do `CLAUDE.md` (Fato; pré-existente, agora vale também para endereços)

- `src/lib/driver/index.ts:23-26`: sem `VERCEL_ENV`, o ambiente vira `development`, e `relaxed` só exige `NODE_ENV !== "production"`. Com `NODE_ENV` ausente ou `"staging"` e sem `VERCEL_ENV`, endereços e store caem em memória e usam o prefixo `finn:development:`.
- Pelo `CLAUDE.md`, qualquer `NODE_ENV` diferente de `development` e `test` é produção.
- Na Vercel isso não acontece, porque `VERCEL_ENV` é sempre definido (**Hipótese**), e `next start` define `NODE_ENV=production`.
- **Correção sugerida:** `relaxed` só quando `NODE_ENV` está em `{development, test}` **e** `VERCEL_ENV` está ausente ou em `{development, test}`, com um teste para `NODE_ENV=staging`.

### B5. Objetos de erro inteiros nos logs de caminhos que o diff alcança (Fato no código; conteúdo, Hipótese; pré-existente)

- Os pontos são:
  - `src/orchestrator/orchestrate.ts:67`;
  - `src/lib/agent-runtime.ts:165` e `src/lib/agent-runtime.ts:183`;
  - `src/agents/spotify/tools.ts:78`;
  - `src/lib/neuralake/client.ts:133` e `src/lib/neuralake/client.ts:229`;
  - `src/lib/spotify/auth.ts:90` e `src/lib/spotify/auth.ts:96-97`.
- O corpo de erro do provedor de LLM (`NeuralakeHttpError` com `res.text()`) pode ecoar a mensagem, isto é, a transcrição com um endereço ditado.
- O corpo de erro do endpoint de token do Spotify não costuma trazer o token. Não verifiquei contra o Spotify real.
- Erros do Redis **não** chegam a esses logs com detalhe (Fato): `UpstashAddressBook.call` (`src/lib/waze/address-book.ts:97-103`) e `UpstashDriverStore.call` trocam tudo por `DriverStoreUnavailableError`. O agente Waze transforma isso em fala curta, sem log (`waze/tools.ts:33-40`, `waze/index.ts:92-102`).
- **Correção sugerida:** logar só `err.name` e o status HTTP. Nunca o objeto nem o corpo.

### B6. O escopo de memória do LLM é por agente, não por motorista (Fato; hoje latente)

- `src/lib/agent-runtime.ts:102` envia `memoryScope: finn-${agent}`, o mesmo para todos os motoristas. Hoje o campo **não é enviado** ao provedor (`src/lib/neuralake/client.ts:172-174`, TODO).
- Se alguém ligar esse TODO, a memória do modelo passa a ser compartilhada entre motoristas, e um endereço ditado por A aparece no contexto de B.
- **Correção sugerida:** tirar o campo, ou incluir nele o `driverId` (ou um hash dele). Um teste que trave o formato.

---

## Verificação por item pedido

### (1) C1 fechado para Spotify e livro de endereços: **Fato, fechado**

- **Spotify, `src/lib/spotify/auth.ts`:**
  - `envRt` só é lido quando `isOwner` (linha 188).
  - Quem não é o dono sai na linha 191 ("Conecte seu Spotify", sem rede) ou na linha 192 (só o próprio token).
  - `refreshAccessToken`, a única leitura de `SPOTIFY_REFRESH_TOKEN`, `rotatedRefreshToken`, `cachedToken` e `pendingRefresh` (linhas 124-133 e 196-204) só é alcançada depois do `return` da linha 192.
  - Os dois fallbacks cruzados foram removidos (eram as linhas `-` do diff, inclusive o `process.env.VITEST`).
  - O retry 401 de `src/lib/spotify/api.ts:76-81` repassa o mesmo `driverId`.
  - `driverId` é campo obrigatório em `SpotifyRequest` (`api.ts:27`), e `player.ts` e `playlists.ts` recebem `who` (Fato no diff).
- **Cache `customTokens`** (`auth.ts:33,136-170`): é compartilhado na instância, mas a chave é o próprio refresh token. Só lê quem já tem o valor (ver M1).
- **Waze:**
  - `getAddressBook(driverId)` é o único ponto de entrada (`address-book.ts:168-176`), e o único chamador é `waze/index.ts:93`.
  - A semente `WAZE_SAVED_ADDRESSES` só existe para o dono (linha 175) e é só leitura (`SeededAddressBook.set` grava no `inner`, linhas 129-131).
  - Com o Redis fora do ar, o dono **não** cai na semente: `inner.get` lança antes do `??` (linha 126).
  - `LayeredAddressBook` e o livro global sumiram (Fato no diff).
- **Outras rotas:** `/api/realtime/*` não chama agentes (busquei `agents`, `orchestrat` e `handle(` nas rotas, sem nenhum resultado). `/api/spotify/*` não usa `getAccessToken`.

### (2) `driverId` nunca vem do corpo, do `driverContext`, da `continuation`, de cookie ou de cabeçalho: **Fato**

- Orquestrador: `driverId: auth.driverId` (`orchestrator/route.ts:52`). O `driverContext` é reconstruído só com `spotifyRefreshToken` (linhas 40-45).
- A2A: o id é a constante fixa (`a2a-server.ts:78`).
- Agentes: só leem `input.driverId` (`spotify/tools.ts:11`, `waze/index.ts:93`).
- A única leitura de cabeçalho que gera identidade é o Bearer em `authorizeDriver` (`auth.ts:164-174`).
- Testes: `orchestrator/route.test.ts:43,59` e `agents/[agent]/route.test.ts:97`.

### (3) Chaves Redis `driver-addr:<id>`

- **Prefixo de ambiente:** sempre presente. `keys.driverAddr(prefix, id)` (`src/lib/driver/store.ts:67-70`) recebe o prefixo de `resolveDriverBackend`, validado por `assertPrefix` (`store.ts:54-56`; `address-book.ts:62,92`). **Fato.**
- **Injeção:**
  - `driverId` passa pela regex `^drv_[A-Za-z0-9_-]{22}$` (`store.ts:40`). `LEGACY_OWNER_DRIVER_ID` também passa, e uma colisão com um id gerado é desprezível.
  - O rótulo vem de lista fechada (`labels.ts:42-44`, conferida em `address-book.ts:67,72,106,112`).
  - O valor tem `trim`, 1 a 200 caracteres e nenhum caractere de controle (`address-book.ts:38-43`). Vai como campo de `HSET` via REST/JSON, sem montagem de comando. **Fato no código.** A codificação do SDK é **Hipótese**.
- **HGETALL em array plano:** `hashToRecord` aceita array plano ou objeto. Tamanho ímpar ou tipo errado vira erro genérico, dentro de `call()` (`upstash-store.ts:70-93`, `address-book.ts:107`). O formato real do Upstash **não foi verificado**: vem do fake.
- **Erro do SDK nunca vaza:** **Fato** (B5, segundo parágrafo). `UrlError`, com a URL do Redis, nasce em `createRedisClient`, dentro de `getAddressBook`, e é engolido sem log em `waze/index.ts:94-101`.
- **Produção sem variáveis falha fechada:** `resolveDriverBackend` lança (`driver/index.ts:31`), e o agente responde com a fala curta. **Fato.** Ressalva para `NODE_ENV` não padrão em B4.

### (4) A2A

- **Limitador antes do Bearer:** **Fato** (`auth.ts:110` antes de `auth.ts:115`). Só falhas contam (`auth.ts:117`).
- **Bypass por IP forjado:** depende de cabeçalho que a Vercel deve sobrescrever (**Hipótese**). Ver B1.
- **Enumeração por 503/401/429:** bits de estado, sem valores. Ver B2.
- **Rotação com NEXT:** `a2aSecrets` (`auth.ts:40-52`) exige os dois válidos, diferentes entre si e diferentes de `FINN_API_TOKEN`. Qualquer erro desliga tudo (503). **Fato.** Testes em `a2a-guard.test.ts:139-190`. Revogar exige redeploy. O token não expira (B3).
- **Tempo constante:** sha256 dos dois lados e `timingSafeEqual` de 32 bytes, num laço sem saída antecipada (`auth.ts:13-15,57-60`). **Fato.**
- **O que o artifact ainda expõe:** só `{ agent, status, speech }` (`a2a-server.ts:97`), e a `speech` também em `status.message` (linha 85).
  - O endereço salvo **não** chega à `speech` (Fato por fluxo de dados). O modelo só recebe o prompt de sistema (sem endereço, `waze/prompt.ts`), a transcrição e resultados com o **rótulo** (`navigating_to: "casa"`, `waze/tools.ts:96`). O endereço só vai para o deep link em `clientActions`, que o A2A descarta.
  - A `speech` pode repetir destinos que o próprio cliente ditou e, no Spotify, os nomes das playlists do dono. Isso é coerente com "credencial do dono".
- **DoS por NAT ou IP compartilhado:** sim, até 10 min (B1). Custo de Redis sem autenticação: M2.
- **Observação:** `agent.handle` no A2A roda sem `signal` nem orçamento de tempo (`a2a-server.ts:78`). Só depois de autenticar; o limite é o `maxDuration` da função (**Hipótese**).

### (5) `continuation` e prompt injection

- **Limitada:** no máximo 2 KB serializada (`src/lib/continuation.ts:9-18`), em `/api/orchestrator` (`route.ts:51`) e no A2A (`a2a-server.ts:65-70`). **Fato.**
- **Estrita:** o Waze aceita só `{pendingLabel: "casa"|"trabalho"}` ou `{awaitingDestination: true}` (`waze/tools.ts:14-20`) e repassa só a versão parseada (`waze/index.ts:87,111`). O Spotify descarta qualquer `continuation` (`spotify/index.ts:173`). No orquestrador, `continuation.agent` é conferido contra `AGENT_IDS` (`orchestrate.ts:134`). **Fato.**
- **Sem assinatura:** o cliente pode forjar `pendingLabel` e disparar uma gravação sem que o agente tenha perguntado. No orquestrador, a gravação vai só para o próprio livro do motorista (Fato, sem impacto cruzado). No A2A, vai para o livro do dono (B3).
- **Injeção por valor salvo:** o valor salvo **nunca volta ao modelo** (ver item 4). Ele só vai para `https://waze.com/ul?q=${encodeURIComponent(...)}` (`src/lib/waze/deep-link.ts:3`), com host fixo, então não há injeção de URL. O prompt de sistema só interpola o rótulo da lista fechada (`waze/prompt.ts:17`). **Fato.**
- **Fora do diff, pré-existente:** nomes de playlists públicas vindos de `/search` voltam ao modelo (`spotify/tools.ts:54-75`). É texto de terceiros num prompt cujo único poder é tocar música do próprio motorista. Registro, não é achado.

### (6) Logs e erros sem segredo nem endereço

- **Fato:**
  - o diff não adiciona nenhum log com valor;
  - `parseSavedAddresses` não loga mais a mensagem do `JSON.parse` e loga só a chave da entrada inválida (`address-book.ts:142,146,154`);
  - `a2aDisabled` loga uma linha fixa (`auth.ts:23`);
  - o `catch` do `guardA2A` não loga nada (`auth.ts:111-113,118-120`).
- `InvalidAddressError` não ecoa o valor (`address-book.ts:27-31`).
- A ressalva sobre o que já existia está em B5.

### (7) O que ainda impede liberar convites em produção, além da entrega 4

1. **M1:** cookie e corpo com o refresh token não ligados ao `driverId`. Precisa ignorar o cookie para convidados, ter logout que limpe o cookie, e depois a entrega 4.
2. **Fora do diff e pré-existente, mas bloqueador:** o callback leva o refresh token na **query string** (`src/app/api/spotify/callback/route.ts:109`, `/?spotify_refresh_token=...`). Ele aparece no histórico do navegador, em `Referer` e, por **Hipótese**, nos logs de requisição da Vercel. Também fica em claro no `localStorage` (`route.ts:94-99`) e na página (`route.ts:88`). A entrega 4 precisa cobrir isso explicitamente, e não só "tirar do `driverContext`".
3. **A1 (entrega 2):** o token legado (`FINN_API_TOKEN`, no `localStorage` do PWA) vira dono quando `FINN_LEGACY_TOKEN_ENABLED=1` (`auth.ts:145-151,167-168`) e não é revogável por motorista. Pelo `ESTADO_ATUAL.md:14`, a decisão está pendente (não confirmei que foi fechada).
4. **A3 + M2:** não há balde global nem regra de firewall. A cota do Upstash pode ser esgotada sem autenticação (`ESTADO_ATUAL.md:67`).
5. **M3 (entrega 2):** não há limite por motorista nas rotas que chamam IA, o que deixa custo aberto a um convidado (`ESTADO_ATUAL.md:70`).
6. **Dívida do contrato:** `revokeDriver` não apaga `driver-addr:<id>`. O endereço do motorista revogado fica para sempre no Redis. Não é alcançável, porque a sessão revogada recebe 401, mas é retenção de dado pessoal.
7. **Processo:** falta o qa deste diff e o lote completo (`npm test && npm run typecheck && npm run lint`), que não rodei.

---

## Não verificado

- Não fiz nenhuma chamada a Upstash, Vercel ou Spotify reais. Ficaram sem confirmação: o formato real do `HGETALL`/`GET` do Upstash, a sobrescrita de `x-vercel-forwarded-for` e `x-forwarded-for` pela Vercel, se os logs da Vercel guardam a query string, e o conteúdo dos corpos de erro do Spotify e do provedor de LLM.
- **Lote completo.** Rodei só os 8 arquivos afetados, com 141 testes passando. Não rodei `npm test`, `typecheck`, `lint` nem `build` completos. Os números do relatório do autor (630 testes) não foram reproduzidos.
- **PWA.** Não abri o PWA. Fica sem verificar a limpeza de `localStorage` e do cookie na troca de motorista, e o uso de `save_address`.
- **`ESTADO_ATUAL.md`.** Não li o arquivo inteiro, só busquei A1, A3 e M3. O estado atual dessas decisões do dono não foi confirmado.
- **`.env*`.** Não abri nenhum `.env*`. A saída do `git diff` mostrou as 3 linhas acrescentadas ao `.env.example`: um comentário e `# FINN_A2A_TOKEN_NEXT=` comentado e vazio. O resto do arquivo não foi visto.
- **Valores das variáveis.** Não verifiquei se `FINN_A2A_TOKEN` existe em algum ambiente. Pelo contrato, não deveria existir.
