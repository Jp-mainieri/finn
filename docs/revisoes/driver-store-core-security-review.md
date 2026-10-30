# Security review: entrega 1, núcleo de identidade (`feat/driver-store-core`)

- Data: 2026-10-26
- Escopo: `git diff feat/driver-identity-store..HEAD` (commits `c42c179`, `acb11fb`, `e95b92a`): `src/lib/driver/**`, `package.json`, `package-lock.json`, relatório do autor. Também li o que o diff toca: `src/lib/env.ts` e o código de `@upstash/redis@1.40.0` em `node_modules`.
- Referência: `docs/contratos/identidade-e-perfil.md` (Invariantes 1 a 5).
- Este documento **não aprova merge**. Ele só relata.
- Legenda: **Fato** = verificado lendo o código ou executando-o localmente. **Hipótese** = depende de um comportamento externo (Upstash, Vercel, entrega 2) que não verifiquei.
- Verificação local sem rede: `npx vitest run src/lib/driver` deu 24/24 passando. Também rodei duas sondas do SDK com `fetch` substituído por stub (sem rede), salvas em `/private/tmp/claude-501/-Users-joaopedropanzamainieri-JP-Projetos-finn/49cb48c2-d2e7-478f-b0d5-d17b5e72d1b9/scratchpad/probe.mjs` e `.../probe2.mjs`. Não li nenhum `.env*`.

## Resumo

| Severidade | Qtde | Itens |
|---|---|---|
| Crítico | 0 | nenhum |
| Alto | 1 | A1 |
| Médio | 6 | M1 a M6 |
| Baixo | 8 | B1 a B8 |
| Bloqueante funcional (não é brecha, falha fechada) | 1 | F1 |

Não encontrei nenhum caminho que libere acesso indevido no núcleo:
- a assinatura é comparada em tempo constante;
- o payload é validado de forma estrita;
- `exp`, `tv` e `sub` ausentes ou fora de forma são rejeitados;
- o resgate é atômico no Lua;
- a seleção de store falha fechada fora de `development`/`test`;
- o prefixo de ambiente é obrigatório e validado.

Os riscos principais são três: vazamento de material de convite em mensagens de erro do SDK, a ausência de um meio de invalidar sessões além de banir o motorista, e o hash de convite ser reversível por força bruta.

---

## F1. Bloqueante funcional: com `automaticDeserialization: false`, `hgetall` devolve array, então ninguém autentica nem resgata no Upstash real (Fato)

- `src/lib/driver/index.ts:29` cria o cliente com `automaticDeserialization: false`.
- No SDK, `node_modules/@upstash/redis/chunk-RLVWMRRX.mjs:367` troca o desserializador por identidade quando essa opção é `false`. Isso anula o desserializador próprio do `HGetAllCommand` (linhas 1940-1963). O resultado é o array cru `["driverId","drv_…","label","A",…]`, confirmado pela sonda com stub.
- `upstash-store.ts:94-95`: `Object.keys(array).length > 0` leva a `toDriver(array)`. Como `h.driverId` é `undefined`, a função devolve `null`. Logo, `getDriver` é sempre `null` e `authenticateSession` sempre falha.
- `upstash-store.ts:122-123`: `typeof inv.label !== "string"` leva a `null`. Logo, todo resgate falha.
- **Efeito de segurança:** nenhum. Falha fechada.
- **Por que reportar aqui:**
  - Os testes não pegaram o problema porque o mock (`driver.test.ts:214-218`) devolve objeto, não array. O mock não é fiel ao SDK.
  - O cast `redis as never` (`index.ts:30`) esconde a divergência.
  - Um conserto apressado em produção, como ligar a desserialização automática, volta a converter rótulos e campos em número. Isso precisa de teste próprio.
- **Recomendação ao `api`/`qa`:**
  - Converter o array em objeto no próprio store, ou usar `HMGET` com campos fixos.
  - Fazer o mock devolver o formato real.
  - Remover o `as never`.

---

## Alto

### A1. Erros do `@upstash/redis` carregam o comando inteiro (chave com `sha256(código)`, `driverId`, IP), e o store não os encapsula (Fato no mecanismo; Hipótese no caminho até o log)

- O SDK monta a mensagem `${error}, command was: ${JSON.stringify(req.body)}` em toda resposta HTTP não-OK (`chunk-RLVWMRRX.mjs:212`). A sonda confirmou a saída `ERR WRONGTYPE, command was: ["hgetall","finn:production:invite:<hash>"]`.
- Com auto-pipelining, que vem ligado por padrão (`chunk-RLVWMRRX.mjs:5003`), o corpo do pedido agrupa comandos de **requisições concorrentes da mesma instância**. Assim, o erro de um motorista pode conter as chaves e os argumentos de outro: `driverId`, rótulo, IP do rate limit. Hipótese de impacto: com Fluid compute há concorrência na mesma instância.
- `upstash-store.ts:94, 99-100, 111, 122, 132-136, 143, 147` repassam a exceção crua.
- A chave `invite:<sha256(código)>` equivale ao código em claro, porque o código tem cerca de 39,6 bits (ver M3). Isso viola a Invariante 3 e o critério de pronto ("nenhum segredo em mensagem de erro").
- Gatilhos realistas, todos hipótese:
  - cota estourada ou 429 do Upstash;
  - token KV rotacionado (401);
  - 5xx;
  - `WRONGTYPE` em chave corrompida.
- Se a entrega 2 deixar a exceção subir num route handler, o Next a imprime nos logs da Vercel (e em log drains).
- **Correção no núcleo:** envolver toda chamada ao Redis num `try/catch` que relança um `DriverStoreError` genérico, sem `message` derivada nem `cause` do SDK.
- **Entrega 2 deve:**
  - nunca logar `err.message`, `err.cause` ou `err.stack` vindos do store;
  - responder erro curto e falável (Invariante 5) sem detalhes.

---

## Médio

### M1. Não existe forma de invalidar sessões sem banir o motorista; `tv` é código morto (Fato)

- O contrato diz: "Revogar = `status: \"revoked\"` ou incrementar `tokenVersion`". Mas nem `DriverStore` (`store.ts:18-28`) nem as implementações têm operação que incremente `tokenVersion`. O valor nasce 1 (`memory-store.ts:49`, `upstash-store.ts:86`) e nunca muda.
- Um token de 90 dias vazado (aparelho perdido, log) só pode ser cortado com `revokeDriver`, que é permanente: não há reativação, e o motorista perde a identidade e, na entrega 4, o vínculo com o Spotify.
- A checagem `driver.tokenVersion !== payload.tv` (`session-token.ts:82`) está correta, mas é inalcançável na prática.
- **Recomendação:** adicionar `rotateSessions(driverId)` com `HINCRBY tokenVersion` atômico e só se a chave existir, e expor isso no script local de revogação.
- **Entrega 2:** `driver:revoke` precisa oferecer as duas opções.

### M2. O prefixo de ambiente não é fronteira de segurança: preview e dev têm credencial com poder sobre `finn:production:*` (Hipótese, depende da configuração da integração na Vercel)

- `index.ts:21-30` usa o mesmo `KV_REST_API_URL`/`KV_REST_API_TOKEN` em qualquer ambiente. O contrato assume um Redis compartilhado.
- Qualquer deploy de preview (qualquer branch) e qualquer `.env.local` puxado com `vercel env pull` podem ler e escrever chaves de produção:
  - revogar motoristas;
  - ler hashes de convite e revertê-los (M3);
  - criar convites.
- O prefixo só evita colisão acidental.
- **Recomendação ao dono:** um banco Upstash separado para produção, ou um token restrito por ACL (se o plano Upstash suportar, hipótese), com as variáveis KV de produção marcadas só para Production na Vercel.

### M3. Hash de convite sem segredo: o espaço de 31^8 ≈ 8,5·10^11 (≈ 39,6 bits) cai por força bruta offline (Fato no cálculo; Hipótese na taxa de GPU)

- `invite.ts:29-31` usa `sha256(código)` puro. Quem lê o Redis (M2) ou um log (A1) recupera o código percorrendo todo o espaço. Com uma GPU comum a cerca de 10^10 SHA-256/s, isso leva da ordem de minutos (hipótese).
- "O código em claro nunca é guardado" (contrato, linha 19) fica nominal.
- **Recomendação:** `HMAC-SHA256(FINN_INVITE_PEPPER, código)`, com o pepper só no servidor e no terminal do dono. Alternativa: aumentar o código, por exemplo `FINN-XXXX-XXXX-XXXX` (cerca de 59 bits).
- Contra força bruta online o tamanho atual basta com rate limit (ver M4).

### M4. Chave do rate limit sem normalização de IP; não há limite global (Fato no núcleo; o bypass depende da entrega 2)

- `invite.ts:35-37` usa a string do IP crua, cortada em 64 caracteres:
  - **IPv6:** cada endereço de um /64 vira um balde novo, e o atacante tem 2^64 baldes.
  - **IP ausente:** `undefined` e `""` viram um balde compartilhado (`ratelimit:redeem:undefined`). Isso é DoS contra todos os usuários sem IP, e não uma falha aberta.
  - **Entrada controlada pelo cliente** (se a entrega 2 ler `x-forwarded-for[0]` de forma ingênua): a chave fica sob controle do atacante. O prefixo `finn:<env>:ratelimit:redeem:` impede que ela escape do namespace.
- Cada palpite bem formado custa até 3 comandos Redis (INCR, HGETALL, EVAL). Girar IPs consome a cota do Upstash, e cota esgotada derruba a autenticação de todos (Invariante 5).
- O limite **não** é só em memória em produção: o Upstash usa `RATELIMIT_SCRIPT`, atômico (Fato). O fake em memória só roda em `development`/`test`.
- **Entrega 2 deve:**
  - obter o IP da fonte confiável da plataforma (`x-vercel-forwarded-for` ou `ipAddress()` de `@vercel/functions`; hipótese sobre qual header a Vercel sobrescreve, confirmar na doc);
  - normalizar IPv6 para /64;
  - recusar quando não houver IP;
  - somar um balde global (`ratelimit:redeem:global`);
  - contar **antes** do resgate e em toda tentativa;
  - tratar exceção do rate limit como negação (`checkRedeemRateLimit` propaga o erro, o que está certo).

### M5. Valor de retorno do Redis aceito sem validação; falha aberta latente no rate limit (Fato por sonda, em configuração não usada hoje)

- `upstash-store.ts:147-148` faz `Number(n)` sem validar.
- Com `signal` (timeout) configurado e auto-pipelining desligado, o SDK sintetiza `{result: null}` com status 200 quando a requisição é abortada (`chunk-RLVWMRRX.mjs` em `request`). Nesse caso `Number(null) = 0`, `0 <= max`, e o **resgate é permitido**. A sonda `probe2.mjs` confirmou `eval on abort -> null, Number: 0`.
- Com a configuração atual (auto-pipelining ligado), o mesmo caso lança `TypeError` e falha fechado.
- Adicionar um timeout é a correção natural para a Invariante 5, e por isso o risco é real.
- **Recomendação:**
  - `incrementRateLimit`: exigir `Number.isSafeInteger(n) && n >= 1`, senão lançar;
  - `redeemInvite`: exigir `ok === 1` estrito;
  - `getDriver`: tratar `null` inesperado como erro, não como "não existe", quando vier de timeout.

### M6. Retentativa automática do SDK em `EVAL` não idempotente, sem timeout (Fato no mecanismo; Hipótese na reexecução no servidor)

- O padrão é 5 retentativas com backoff `e^i·50 ms` (`chunk-RLVWMRRX.mjs:134`) em qualquer exceção do `fetch`. Na sonda: 6 chamadas e cerca de 4,3 s antes de falhar.
- Não há `signal` de timeout (`index.ts:29`). Uma conexão pendurada espera até o limite da função, o que contraria a Invariante 5.
- Se o primeiro `EVAL` de resgate executou e a resposta se perdeu, a retentativa roda de novo com os **mesmos** argumentos (mesmo `driverId`):
  - queima um uso a mais;
  - ou, com `maxUses` atingido, devolve 0. O cliente recebe "código inválido" e fica um driver órfão.
- Não cria dois motoristas diferentes, então a atomicidade se mantém.
- **Recomendação:** `retry: false` (ou retentar só leituras) e `signal: () => AbortSignal.timeout(…)` curto, junto com M5.

---

## Baixo

### B1. Oráculo de tempo na enumeração de convites (Fato, ativo depois de corrigir F1)

- Em `upstash-store.ts:122-136`:
  - código inexistente custa 1 ida ao Redis (`HGETALL`);
  - código existente mas esgotado, expirado ou revogado custa 2 (`HGETALL` + `EVAL`).
- A saída é idêntica (`null`), mas a diferença de latência revela que o código existe.
- O ganho para o atacante é baixo: só confirma códigos mortos.
- **Correção:** ler `label` dentro do `REDEEM_SCRIPT` (um único `EVAL` sempre).
- **Entrega 2:** mesmo status, mesmo corpo e mesmos headers para todos os casos de falha, incluindo código mal formado.

### B2. A assinatura do token não é canônica em base64url (Fato)

- `session-token.ts:54` usa `Buffer.from(sig, "base64url")`, que aceita:
  - 4 variações do último caractere;
  - `=`, `!`, espaço e quebra de linha anexados ou intercalados.
- Testado: todas as variações validam.
- Não permite forjar (o payload é assinado como string).
- Porém, o token não é único. Uma denylist ou cache indexado pela string do token seria contornável.
- **Correção:** exigir `/^[A-Za-z0-9_-]{43}$/` na assinatura (e base64url estrito no corpo), ou comparar a string reencodada.
- **Entrega 2:** nunca indexar estado pela string do token; usar `(sub, tv)`.

### B3. O token não tem vínculo com o ambiente (Fato; impacto Hipótese)

- O payload `{sub, iat, exp, tv}` (`session-token.ts:40`) não traz `env`/`aud`.
- O contrato pede `FINN_SESSION_SECRET` distinto por ambiente, mas nada impõe isso.
- Se o segredo for igual entre preview e produção, e a entrega 2 mapear o token legado para um `driverId` **fixo** de dono (igual nos dois ambientes, com `tv=1`), um token emitido num preview vale em produção.
- **Correção:** incluir o prefixo de ambiente na entrada do HMAC (ou um claim `aud` checado).

### B4. Segredo mínimo de 32 caracteres, sem exigir 64 hex (Fato)

- `session-token.ts:6, 18, 27`: o contrato pede 32 bytes hex (64 caracteres), mas o código aceita 32 caracteres quaisquer (por exemplo `"a"*32`).
- A mensagem de erro só cita o nome da variável (`env.ts:9`, `session-token.ts:18`), não o valor. Isso está OK.
- **Correção:** validar `/^[0-9a-f]{64}$/i`.

### B5. `authenticateSession` não confere `driver.driverId === payload.sub` (Fato)

- `session-token.ts:81-83` devolve o `Driver` lido do hash, cujo `driverId` vem do conteúdo (`upstash-store.ts:52-55`), não da chave.
- Só um hash corrompido exploraria isso, porque só o servidor escreve.
- **Correção:** é defesa em profundidade e custa uma linha.
- **Entrega 2:** `authorizeDriver` deve devolver `payload.sub` validado, nunca um `driverId` vindo de body, query ou header (Invariante 1).

### B6. `keys.rateLimit` aceita chave livre dentro do namespace do ambiente (Fato)

- `store.ts:52` monta `${prefix}${key}` sem forçar `ratelimit:`.
- Uma chamada futura com chave derivada de entrada do usuário poderia atingir `driver:*`/`invite:*` (`INCR` daria `WRONGTYPE`, e esse erro carrega a chave, ver A1) ou criar strings nesses nomes.
- `spotifyIndex` (`store.ts:51`) também não valida `spotifyUserId` (entrega 4).
- **Correção:** forçar `ratelimit:` e validar o charset da chave, com tamanho máximo.

### B7. Entrada de convite sem teto (Fato)

- `store.ts:55-61` aceita:
  - `maxUses` sem máximo (um convite de 10^6 usos é um cadastro público);
  - `expiresAt` sem máximo, ou no passado;
  - a unidade (ms) não é verificada. Segundos por engano expiram na hora, o que é falha fechada.
- `windowSeconds` não é validado em `incrementRateLimit`. Com 0 ou um valor negativo, o fake em memória zera a janela a cada chamada (`memory-store.ts:102-103`), e no Redis o `EXPIRE` com valor ≤ 0 apaga a chave. Nos dois casos o limite fica desligado se a entrega 2 passar um valor inválido.
- **Correção:** tetos explícitos e validação de `windowSeconds >= 1`.

### B8. Dependência nova `@upstash/redis@1.40.0` (Fato no lockfile; Hipótese na procedência)

- O lockfile aponta para `registry.npmjs.org`, com integridade sha512, licença MIT e uma única transitiva (`uncrypto@0.1.3`).
- Não há `hasInstallScript`; os scripts do pacote são só build/test.
- O range `^1.40.0` aceita minors novos fora do `npm ci`.
- Por padrão o SDK envia headers de telemetria (runtime, plataforma, versão; sem segredos), e isso se desliga com `enableTelemetry: false`.
- Não verifiquei data de publicação, mantenedores nem advisories (proibido rede).
- **Recomendação:** fixar a versão exata, `enableTelemetry: false` e `npm audit` pelo dono.

---

## Pontos verificados sem achado

| Ponto | Situação (Fato) |
|---|---|
| Comparação da assinatura | `timingSafeEqual` com checagem prévia de tamanho fixo (32 bytes), `session-token.ts:57` |
| Algoritmo/versão | Só `v1`, HMAC-SHA256 fixo, sem campo de algoritmo no token |
| Payload | `sub` validado por regex de `driverId`; `iat`/`exp`/`tv` inteiros obrigatórios; `exp` ausente ou vencido leva a `null`; JSON inválido leva a `null` sem lançar (`session-token.ts:59-69`) |
| Revogação | `authenticateSession` lê o Redis a cada chamada, sem cache no núcleo; `cache: "no-store"` no SDK (`nodejs.mjs:229`). Janela por réplica de leitura do Upstash global é hipótese |
| Entropia do `driverId` | 128 bits via `randomBytes(16)`, `invite.ts:19-21` |
| Geração do código | `randomInt` do `node:crypto` (sem viés de módulo), `invite.ts:8-12` |
| Atomicidade do resgate | Checagem + `HINCRBY` + `HSET` do motorista num só `EVAL` (`upstash-store.ts:25-34`); o fake não tem `await` entre checar e incrementar (`memory-store.ts:85-87`) |
| Código em claro | Nunca persistido nem logado no núcleo; não há `console.*` em `src/lib/driver/**` |
| Falha aberta na seleção | `VERCEL_ENV` ausente com `NODE_ENV=production`, `preview`, `production`, valores desconhecidos ou KV parcial levam a lançar erro (`index.ts:21-33`); `VERCEL_ENV=""` também lança (prefixo inválido) |
| Isolamento entre motoristas | Toda chave de motorista é `finn:<env>:driver:<driverId>`; nenhuma estrutura global com dados de motorista |
| Segredos em testes | Só valores sintéticos (`"a".repeat(64)`, `https://x.example`, `"t"`) |

## O que a entrega 2 precisa respeitar (consolidado)

1. `authorizeDriver` deriva identidade só do token validado por `authenticateSession`; nada de `driverId` vindo do cliente. Rotas em `runtime = "nodejs"` (`node:crypto`).
2. O token vai no header `Authorization` (nunca na query string). Não logar esse header nem o corpo de `/api/session`.
3. Encapsular e não registrar erros do store (A1). A resposta ao motorista deve ser curta e falável.
4. `POST /api/session` com resposta idêntica (status, corpo, headers) para código inexistente, mal formado, expirado, esgotado e revogado (B1).
5. Rate limit antes do resgate, em toda tentativa: IP confiável, IPv6 em /64, IP ausente recusado, balde global, erro tratado como negação (M4, M5).
6. Token legado:
   - ligado só com `FINN_LEGACY_TOKEN_ENABLED === "1"` estrito;
   - comparação em tempo constante (`timingSafeEqual` sobre `sha256` dos dois lados, para igualar tamanhos);
   - o `driverId` de dono precisa existir no store e passar por `status`/`tv`;
   - não reutilizar `FINN_SESSION_SECRET` entre ambientes (B3).
7. Scripts `invite:create|invite:revoke|driver:revoke`:
   - exigir ambiente alvo explícito e imprimir o prefixo antes de escrever;
   - ler o código de revogação por stdin, não por argv (histórico do shell, `ps`);
   - imprimir o código novo uma única vez;
   - oferecer `rotateSessions` (M1).
8. O rótulo do motorista volta ao cliente: o PWA (entrega 5) deve tratá-lo como texto, nunca HTML.
