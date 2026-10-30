# Security review: entrega 2, rotas de sessão e autorização (`feat/driver-session-routes`)

- Data: 2026-10-26
- Escopo: `git diff feat/driver-store-core..HEAD` (commits `4b4f1c5` a `819fbb1`, 31 arquivos). Também li o que o diff toca e passa a expor: `src/lib/driver/{index,invite,session-token,store,upstash-store,redis-client}.ts`, `src/app/api/agents/[agent]/route.ts`, `src/lib/spotify/auth.ts`, `src/agents/waze/index.ts`, `src/lib/waze/address-book.ts`, `src/lib/a2a-server.ts`, `next.config.ts`, `vercel.ts` e o SDK `@upstash/redis` em `node_modules`.
- Referências: `docs/contratos/identidade-e-perfil.md` (Invariantes 1 a 5, Rotas e autorização, Histórico), `docs/relatorios/driver-session-routes-2026-10-26.md` e a lista "O que a entrega 2 precisa respeitar" de `docs/revisoes/driver-store-core-security-review.md`.
- Decisões já tomadas e não reabertas aqui: identidade opção B, convites por script local, Redis único separado só por prefixo (M2 aceito), token legado só com `FINN_LEGACY_TOKEN_ENABLED === "1"` e B3 não será feito.
- Este documento **não aprova merge**. Ele só relata.
- Legenda: **Fato** = verificado lendo o código ou executando-o localmente. **Hipótese** = depende de comportamento externo (Vercel, Upstash, variáveis reais) que não verifiquei.
- Verificação local, sem rede e sem ler `.env*`:
  - `npx vitest run src/lib/auth.test.ts src/app/api/session tests/acceptance/driver-auth-routes.test.ts tests/acceptance/auth.test.ts tests/scripts src/lib/driver`: 8 arquivos, 141 testes, todos passaram.
  - Sondas em Node 24.14:
    - `NODE_OPTIONS=--env-file=...` é recusado ("--env-file= is not allowed in NODE_OPTIONS");
    - `Request.json()` aceita corpo JSON com `content-type: text/plain`;
    - `JSON.parse('{"__proto__":{"inviteCode":"x"}}').inviteCode` dá `undefined`.

## Resumo

| Severidade | Qtde | Itens |
|---|---|---|
| Crítico | 1 | C1 |
| Alto | 3 | A1, A2, A3 |
| Médio | 3 | M1, M2, M3 |
| Baixo | 6 | B1 a B6 |

O mecanismo novo está correto:
- `authorizeDriver` só tira o `driverId` do token assinado e confere `status`/`tv` no Redis;
- os erros do store são encapsulados e nada é logado;
- `/api/session` responde de forma idêntica para todo código inválido e usa `no-store`;
- o resgate continua atômico, agora com `SADD` no mesmo EVAL.

O problema principal está no que esse mecanismo **passa a abrir**. A partir do primeiro convite resgatado, um terceiro chega ao orquestrador, que ainda usa o Spotify e os endereços **do dono** (C1). Além disso, o token legado não é revogável e continua aceito em `/api/agents/*` mesmo com a flag desligada (A1, A2). E o Redis do plano Free pode ser esgotado sem autenticação (A3).

---

## Crítico

### C1. Motorista convidado opera o Spotify do dono e lê os endereços do dono (Fato no código; Hipótese só nas variáveis presentes em cada ambiente)

O diff troca `authorize` por `authorizeDriver` em `src/app/api/orchestrator/route.ts:14-15`. A partir daí, qualquer convidado entra no orquestrador. O `auth.driverId` não é usado em nenhum ponto da rota (linhas 29-46). O orquestrador repassa ao agente só o `driverContext` vindo do corpo do pedido ou do cookie. O que acontece em seguida:

- **Spotify do dono.**
  - Sem `spotifyRefreshToken` próprio, `getAccessToken` cai em `refreshAccessToken` (`src/lib/spotify/auth.ts:209-213`), que usa `SPOTIFY_REFRESH_TOKEN` do servidor (linha 112), isto é, a conta do dono.
  - Com um token próprio que falhe, também cai no do dono (linhas 187-196).
  - Qualquer convidado pode tocar, pausar e listar as playlists do dono.
  - O próprio smoke (`tests/smoke/session.mjs:59`, "pausa a música" com um motorista recém-criado) pausa o Spotify do dono, se o ambiente tiver `SPOTIFY_REFRESH_TOKEN` (hipótese). O comentário na linha 11 diz "Spotify do motorista", mas não é.
- **Endereços do dono.**
  - `src/agents/waze/index.ts:87-89` lê `getAddressBook()`, que é global e semeado por `WAZE_SAVED_ADDRESSES` (`src/lib/waze/address-book.ts:93`).
  - "Me leva pra casa" devolve ao convidado a URL do Waze com o endereço de casa do dono, em `clientActions` e em `results[].toolCalls`.
- **Escrita global.**
  - `LayeredAddressBook.set` grava no livro base (`address-book.ts:62`).
  - Sem `savedAddresses`, a escrita cai direto no livro global da instância.
  - Assim, um motorista sobrescreve o "casa" que outro vê na mesma instância.
- Isso viola a Invariante 4 ("nenhuma estrutura global compartilhada entre motoristas") e o item da tarefa "dado de um motorista alcançável por outro".
- O contrato deixa a correção para as entregas 3 e 4, mas a entrega 2 é a que abre a porta. **Condição:** o risco vale assim que existir um convite resgatado num ambiente com essas variáveis. Hoje nenhum foi emitido (relatório do autor, seção 3).
- **Recomendação (escolha do dono, não reabre decisão):**
  - não emitir convite em produção antes das entregas 3 e 4; ou
  - adicionar uma trava mínima já: quando `auth.driverId !== LEGACY_OWNER_DRIVER_ID`, desligar o fallback para `SPOTIFY_REFRESH_TOKEN` e para o livro global.
  - Em preview, rodar o smoke só com `SPOTIFY_REFRESH_TOKEN` ausente, ou aceitar que ele pausa o Spotify do dono.
- **Entrega 3:**
  - endereço chaveado por `auth.driverId` vindo de `authorizeDriver`;
  - nunca ler nem escrever o livro global para um convidado;
  - parar de aceitar `driverContext.savedAddresses` do corpo como fonte de verdade;
  - não devolver o endereço em `results` brutos.
- **Entrega 4:**
  - remover o fallback para o token do servidor em qualquer caminho de convidado, inclusive no de erro (`auth.ts:187-196`);
  - parar de aceitar refresh token do corpo ou do cookie `finn_spotify_rt` (`orchestrator/route.ts:30-39`);
  - não logar `customErr` (`spotify/auth.ts:189-192`) sem antes conferir que ele não carrega o token.
- **Entrega 5:** o PWA não deve mandar `spotifyRefreshToken` nem `savedAddresses` no corpo.

---

## Alto

### A1. O token legado é identidade de dono permanente: sem registro no store, sem `tv`, sem expiração e irrevogável por motorista (Fato)

- `src/lib/auth.ts:34` fixa `LEGACY_OWNER_DRIVER_ID = "drv_legacy_owner_000000000"`. As linhas 74-75 devolvem esse id sem consultar o store.
- O item 6 da lista da revisão anterior ("o `driverId` de dono precisa existir no store e passar por `status`/`tv`") **não foi cumprido**:
  - `driver:revoke`/`driver:rotate` dizem "Motorista não encontrado" para esse id (`scripts/lib/admin-cli.mjs:140-144`);
  - o único corte é desligar a flag ou trocar `FINN_API_TOKEN`, e as duas coisas exigem mexer em variável da Vercel e fazer novo deploy (hipótese sobre o deploy);
  - o token não expira.
- Hoje o acesso é um token **compartilhado**. Quem o tiver vira "o dono" (`GET /api/session` devolve `label: "Dono"`, `src/app/api/session/route.ts:62`).
- A flag está ligada nos 3 ambientes (`docs/relatorios/orquestrador-2026-10-26.md`, item 9). Logo, qualquer preview de qualquer branch aceita o token (hipótese sobre a Deployment Protection).
- Quando as entregas 3 e 4 gravarem perfil e Spotify sob esse id, todo portador do token compartilhado terá o perfil e o Spotify do dono.
- **Recomendação:**
  - criar o registro do dono no store (com `status`/`tv`) e validar o legado contra ele; ou
  - definir uma data de desligamento da flag e só então gravar dado de perfil;
  - em ambos os casos, desligar a flag em Preview e Development se o carro usa só produção (decisão do dono).
- **Entrega 3:** não gravar dado de perfil sob `LEGACY_OWNER_DRIVER_ID` sem resolver isto, e prever a migração desse id para o `driverId` real do dono quando a flag cair.
- **Entrega 5:** o PWA novo não deve oferecer campo para o token compartilhado.

### A2. Desligar `FINN_LEGACY_TOKEN_ENABLED` não fecha o token compartilhado: `/api/agents/*` o aceita sempre e executa agentes com os recursos do dono (Fato)

- `src/app/api/agents/[agent]/route.ts:7` usa `authorize()` (`src/lib/auth.ts:9-27`), que ignora a flag.
- O A2A (`src/lib/a2a-server.ts:51-57`) não recebe `driverContext`. Por isso o agente Spotify usa `SPOTIFY_REFRESH_TOKEN` do dono e o Waze usa o livro global.
- Cada chamada consome Neuralake (LLM) e não tem limite.
- A "transição" do token legado fica incompleta: com a flag desligada, o mesmo segredo continua controlando o Spotify do dono e lendo a casa dele.
- O contrato põe `/api/agents/*` fora desta etapa. Registro aqui como risco aberto, não como desvio.
- **Recomendação:**
  - um segredo próprio para o A2A (separado do `FINN_API_TOKEN` usado no carro); ou
  - condicionar `/api/agents/*` à mesma flag; ou
  - registrar no `ESTADO_ATUAL.md` que o A2A continua sendo porta do dono.
- **Entregas 3 e 4:** o A2A não pode ganhar acesso a dado por motorista sem uma identidade própria.

### A3. Esgotar a cota do Redis (plano Free) sem autenticação derruba todos os motoristas (Fato no mecanismo; Hipótese na cota e no comportamento ao esgotar)

- Todo `POST /api/session` com `inviteCode` string não vazia faz pelo menos 1 comando Redis (EVAL do rate limit, `src/app/api/session/route.ts:44`, `src/lib/driver/invite.ts:116`, `upstash-store.ts:216`), **mesmo depois de estourar o limite**. Um código bem formado dentro do limite custa 2.
- Não há balde global nem filtro antes do Redis. O item 5 da lista anterior ("balde global") não foi feito.
- `ESTADO_ATUAL.md` registra plano Free. A cota mensal do plano Free do Upstash é da ordem de centenas de milhares de comandos (hipótese, não verificada).
- Basta um único IP repetindo o pedido, sem precisar girar IPs, para consumir a cota.
- Com a cota esgotada (hipótese: o Upstash passa a responder erro):
  - todo `authorizeDriver` de token `v1.` vira 503 (`auth.ts:82-84`);
  - todo resgate falha;
  - a voz para para todos os convidados até a virada do mês. Só o legado continua.
- Também pesa contra a Invariante 5.
- Agravante: CSRF simples amplia a origem dos pedidos (ver B3).
- **Recomendação:**
  - regra de rate limit no firewall da Vercel para `/api/session` (não gasta Redis; hipótese sobre disponibilidade no plano);
  - alerta de orçamento no Upstash;
  - balde global.
- **Entrega 3:** cada leitura de perfil soma comandos por requisição. Medir o custo por turno de voz e manter 1 leitura de sessão por requisição.
- **Entrega 5:** sem retry automático em 401/429/503. Respeitar `Retry-After`.

---

## Médio

### M1. Os npm scripts do dono não conseguem carregar `--env-file`, o que empurra credenciais para o histórico do shell (Fato)

- `scripts/lib/admin-cli.mjs:2-3,27` manda usar `node --env-file=<arquivo>`. Porém os npm scripts (`package.json:15-19`) chamam `node ...` sem esse flag.
- `npm run invite:create -- --env-file=...` é recusado por `parseArgs` (`admin-cli.mjs:47`).
- No Node 24.14, `NODE_OPTIONS=--env-file=...` também é recusado (sonda).
- Caminhos que sobram ao dono:
  - `KV_REST_API_TOKEN=... FINN_INVITE_PEPPER=... npm run ...`, que deixa o token do Redis (com poder sobre os 3 ambientes, M2 aceito) e o pepper de produção no histórico do shell;
  - `export`/`source` de um arquivo;
  - montar à mão a linha de comando de `node` com os 4 flags.
- O relatório diz que o script foi "provado via npm run (recusas)": as recusas acontecem antes de qualquer credencial ser necessária.
- **Recomendação:** um flag próprio `--env-file <arquivo>` lido com `process.loadEnvFile` (só o caminho em argv, nunca o valor), ou `--env-file-if-exists` fixo por ambiente no npm script.

### M2. `--env` não está amarrado ao pepper: um `invite:revoke` com o arquivo de outro ambiente, ou com código mal digitado, não faz nada, avisa "Pedido de revogação enviado" e sai com 0 (Fato)

- O prefixo vem de `--env` (`admin-cli.mjs:77`), mas o pepper vem do processo (`upstash-store.ts:118-120`, `invite.ts:52-55`). Os peppers são distintos por ambiente.
- Com o arquivo errado:
  - `invite:create --env production` grava um convite que produção não resgata (falha fechada);
  - `invite:revoke` calcula outro HMAC, `EXISTS` dá 0 (`upstash-store.ts:44-48`) e nada muda.
- Código com caractere ambíguo (0/O/1/I/L) ou fora do formato: `revokeInvite` retorna cedo (`upstash-store.ts:206-207`).
- Nos dois casos o script imprime a mesma mensagem e sai com 0 (`admin-cli.mjs:125-127`). **O convite continua válido em produção.**
- Item 7 da lista anterior:
  - o código de revogação ainda vem por argv (`admin-cli.mjs:124`), não por stdin, e fica no histórico e no `ps`;
  - `invite:create` não imprime o prefixo antes de escrever.
- `--confirm-production` é um flag nu. Serve como trava contra acidente, não contra quem roda o script, e isso basta. Mas ele não detecta o arquivo de credenciais errado.
- **Recomendação:**
  - validar o código com `normalizeInviteCode` no script e recusar se for inválido;
  - fazer o `REVOKE_SCRIPT` devolver se a chave existia e o script sair com 1 quando não existir;
  - ler o código por stdin;
  - comparar `VERCEL_ENV` do arquivo carregado com `--env`, ou guardar uma impressão do pepper (HMAC de uma constante) por prefixo e conferir.

### M3. Sem limite por motorista nem global nas rotas que chamam IA; sem limite para tentativas de Bearer (Fato; o contrato põe "rate limit geral por motorista" fora de escopo)

- `/api/orchestrator` (Neuralake), `/api/realtime/transcribe` (Groq/OpenAI), `/api/realtime/tts` e `/api/realtime/session` (OpenAI) só checam `authorizeDriver` (`orchestrator/route.ts:14`, `transcribe/route.ts:10`, `tts/route.ts:71`, `session/route.ts:20`).
- Um convidado, ou um token de 90 dias vazado, consome cota paga sem teto. O corte depende do dono notar e rodar `driver:revoke`/`driver:rotate`.
- Falhas de Bearer também não são contadas. Isso permite força bruta online do `FINN_API_TOKEN` sem freio; a viabilidade depende da entropia do token, que não verifiquei (hipótese).
- Abrir o app a terceiros muda o peso do "fora de escopo".
- **Recomendação:** registrar como risco aceito ou pôr um balde por `driverId` (as chaves já aceitam `ratelimit:` com escopo).
- **Entrega 3:** se houver limite por motorista, a chave deve ser `ratelimit:<rota>:<driverId>` vindo do token, nunca do corpo.

---

## Baixo

### B1. Legado compara com `timingSafeEqual` mas sai antes por tamanho: vaza o comprimento do token (Fato)

- Ocorre em `src/lib/auth.ts:55-57`, e o mesmo padrão já existia em `authorize()` (`auth.ts:18-20`).
- O item 6 da lista anterior pedia `sha256` dos dois lados.
- O impacto é pequeno: revela só o tamanho.

### B2. Rate limit por IP: precedência de cabeçalhos e balde `noip` compartilhado (Fato no código; Hipótese no comportamento da Vercel)

- `src/lib/client-ip.ts:14` lê `x-vercel-forwarded-for`, depois `x-real-ip`, depois o 1º de `x-forwarded-for`.
- **Na Vercel:** a plataforma sobrescreve esses cabeçalhos (hipótese declarada no próprio arquivo e não verificada).
  - `x-vercel-forwarded-for` é usado inteiro, sem `split(",")`. Se algum dia vier como lista, por exemplo com outro proxy na frente (Cloudflare), `isIP` falha e **todos** caem em `noip`, com 3 tentativas a cada 10 minutos para o mundo inteiro (`invite.ts:59-60`). Isso é DoS de convites legítimos.
- **Fora da Vercel** (`next start`, outro host): os três cabeçalhos são do cliente, então há baldes ilimitados. O resgate continua seguro, porque o espaço de cerca de 8,5·10^11 códigos inviabiliza força bruta online, mas isso amplia A3.
- IP ausente não é recusado: vai para `noip`, que é falha fechada mas compartilhada. IPv6 é normalizado para /64 (ok).
- **Recomendação:**
  - pegar o 1º item de `x-vercel-forwarded-for`;
  - confirmar na documentação da Vercel quais cabeçalhos ela sobrescreve;
  - num deploy fora da Vercel, recusar quando não houver fonte confiável.

### B3. `POST /api/session` aceita `text/plain` e não confere `Origin`: CSRF simples, sem preflight (Fato)

- `src/app/api/session/route.ts:30` usa `request.json()`, que ignora o content-type (sonda).
- Um site de terceiros pode fazer o navegador de quem o visita postar códigos. Ele não lê a resposta, porque não há CORS (`next.config.ts` não define nenhum).
- Não há fixação de sessão (o token vai no corpo, não em cookie). O ganho do atacante é usar os IPs dos visitantes para ampliar A3.
- O corpo não tem teto antes do `json()`. Ele fica limitado pelo limite da plataforma (hipótese: 4,5 MB na Vercel) e não gasta Redis.
- `__proto__` e tipos errados são tratados (sonda e linhas 31-36).
- **Recomendação:** exigir `content-type: application/json` (o que força preflight) e/ou conferir `Origin` com o host. Ler o corpo com teto de alguns KB.
- **Entrega 5:** o PWA envia `application/json`.

### B4. Resgate não idempotente: convite pode ser consumido sem token entregue (Fato no mecanismo; Hipótese na frequência)

- O timeout do cliente Redis é de 2 s, sem retentativa (`redis-client.ts:3,21-22`). Se o EVAL executou e a resposta se perdeu, o servidor responde 503 (`session/route.ts:51-52`) com o convite gasto.
- O mesmo acontece se a resposta HTTP se perder na rede, e com double-submit (o segundo pedido recebe 401 "Convite inválido").
- Com o padrão de 1 uso (`admin-cli.mjs:15`), o convidado fica sem acesso. O motorista órfão aparece em `driver:list` e não há comando para reemitir token. Não é brecha: o token nunca é exposto.
- A ordem "segredo antes do resgate" (linhas 41-42) está certa e evita o caso de configuração ausente.
- **Entrega 5:** desabilitar o botão durante o envio; nunca reenviar o resgate automaticamente; em 503, orientar a pedir novo convite.

### B5. O smoke não recusa produção e deixa um motorista ativo para trás (Fato)

- `tests/smoke/session.mjs`:
  - não imprime token, código nem corpo (ok, linhas 45-48);
  - aceita qualquer `baseUrl` (linha 18), inclusive produção;
  - recebe o código por argv (histórico do shell; o código é consumido no uso);
  - o motorista criado continua `active` depois do teste.
- Junto com C1, o passo 59 age no Spotify do dono.
- **Recomendação:** recusar o domínio de produção, salvo com flag explícito; ao final, instruir `driver:revoke` do id criado. O id pode ser impresso, porque não é segredo, mas hoje não é.

### B6. Sinais de enumeração e erros: sem vazamento (Fato; registro de verificação)

- Para código inexistente, mal formado, expirado, esgotado ou revogado, o status, o corpo e os cabeçalhos são idênticos (`session/route.ts:18-19,47`).
- O único sinal é 1 ida ao Redis para formato inválido contra 2 para formato válido. Isso só revela o formato, que o atacante já conhece.
- O 503 (`auth.ts:40-41`) é curto e sem detalhe. Nenhum `console.*` nas rotas novas.
- O `UrlError` do SDK traz a URL do Redis (`chunk-RLVWMRRX.mjs:23`), mas é capturado sem log nas rotas e vira mensagem genérica no script (`admin-cli.mjs:173`).
- Fica como baixo só porque qualquer `console.error(e)` futuro nesses `catch` reabre A1 da revisão anterior.
- **Entregas 3 e 5:** manter o `catch` mudo e nunca logar `e`.

---

## Checklist da revisão anterior ("o que a entrega 2 precisa respeitar")

| # | Item | Situação |
|---|---|---|
| 1 | Identidade só do token; runtime Node | **Cumprido.** `auth.ts:78-81`; `session-token.ts:110` confere `driverId === sub`. Sem `runtime` explícito, mas a rota importa `node:crypto` e o build passou (padrão nodejs) |
| 2 | Token no header; não logar | **Cumprido.** `extractBearer` (`auth.ts:43-48`); sem logs |
| 3 | Erros do store encapsulados; resposta falável | **Cumprido.** `upstash-store.ts:123-129`; 503 curto em português |
| 4 | Resposta idêntica no resgate | **Cumprido** (B6) |
| 5 | Rate limit antes do resgate, IP confiável, /64, IP ausente recusado, balde global, erro = negação | **Parcial.** Antes do resgate, /64 e erro = 503 estão feitos. IP ausente não é recusado (vai para `noip`); **sem balde global** (A3); cabeçalho só por hipótese (B2) |
| 6 | Legado: flag estrita, tempo constante, dono no store com `status`/`tv`, segredos distintos | **Parcial.** A flag estrita está feita. O tamanho vaza (B1). **O dono não está no store** (A1). Segredos distintos: registrado em `ESTADO_ATUAL.md` |
| 7 | Scripts: env explícito com prefixo impresso, código de revogação por stdin, imprimir uma vez, `rotateSessions` | **Parcial.** `--env` obrigatório, impressão única e `driver:rotate` estão feitos. **Revogação por argv**, prefixo não impresso em `invite:create`, `--env-file` impossível pelos npm scripts (M1, M2) |
| 8 | Rótulo como texto no PWA | **Pendente** (entrega 5) |

## Pontos verificados sem achado (Fato)

| Ponto | Situação |
|---|---|
| Rotas de IA sem `authorizeDriver` | Nenhuma: orchestrator e as 3 de realtime trocadas; `/api/agents/*` com `authorize()` (A2); `card` é público e não chama IA; `spotify/login|callback` estão fora do diff |
| Métodos | `/api/session` exporta só `POST` e `GET`; os outros dão 405 pelo Next |
| `Cache-Control: no-store` | Em todas as respostas de `/api/session`, inclusive a com token (`route.ts:13,50,62`) |
| Falha aberta | Segredo ausente ou fraco, store sem KV, pepper ausente ou inválido: tudo vira 503 ou 401, nunca acesso (`auth.ts:77-85`, `route.ts:38-53`, `index.ts:32`). Pepper inválido lança antes do EVAL, então não queima convite |
| EVAL com 3ª chave e `SADD` | Atômico no mesmo script (`upstash-store.ts:32-42`); o índice só recebe o id junto do hash. `createDriver` (sem uso fora de testes) faz `SADD` e depois `HSET` em 2 chamadas, e o órfão é ignorado por `listDrivers` |
| `listDrivers` | Só chamado por `scripts/lib/admin-cli.mjs:131`; nenhuma rota o expõe; devolve id, rótulo, status e data, nunca segredo |
| Injeção pelos argumentos do script | Sem shell: `parseArgs` estrito, `--env=x` recusado, rótulo sem caracteres de controle (`store.ts:81-88`), `driverId` validado |
| Segredos nos testes | Valores sintéticos, já presentes na base `feat/driver-store-core`; o teste do CLI verifica que URL, token, pepper e segredo nunca saem (`tests/scripts/admin-cli.test.ts:89-104`) |
| Dependências novas | Nenhuma: `package-lock.json` sem diff; `package.json` só ganhou scripts. `registerHooks` é nativo do Node 24 |
| `.env.example` | Só nomes e formatos, sem valores |

## Resumo para as próximas entregas

- **Entrega 3:**
  - usar só `auth.driverId`;
  - acabar com leitura e escrita no livro global para convidados (C1);
  - não gravar perfil sob `LEGACY_OWNER_DRIVER_ID` antes de resolver A1;
  - chaves `finn:<env>:` com escopo de motorista;
  - medir comandos Redis por turno (A3);
  - `catch` mudo (B6).
- **Entrega 4:**
  - eliminar o fallback para `SPOTIFY_REFRESH_TOKEN` em caminho de convidado, inclusive no de erro;
  - parar de aceitar refresh token do corpo ou do cookie;
  - não logar `customErr` (C1);
  - A2A sem acesso a dado por motorista (A2).
- **Entrega 5 (PWA):**
  - token só em `Authorization`, nunca em URL;
  - `content-type: application/json` (B3);
  - sem reenvio automático do resgate, botão desabilitado durante o envio (B4);
  - respeitar `Retry-After` (A3);
  - rótulo tratado como texto;
  - sem `spotifyRefreshToken` ou `savedAddresses` no corpo;
  - sem campo para o token compartilhado (A1).
