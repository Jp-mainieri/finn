# Security review: limites por motorista nas rotas de IA (M3)

- Branch: `feat/ai-rate-limits`. Diff revisado: `git diff 2fdcee1 HEAD` (10 commits, 88fac6c no topo).
- Contrato: `docs/contratos/limites-por-motorista.md`, lido até a última linha do Histórico (a rajada é checada primeiro e não toca no Redis).
- Revisor: security-review (Opus), 2026-10-28. Só leitura: nenhum código editado, nenhuma mutação, nenhum commit. Este relatório não aprova o merge.

## Resumo

Nenhum achado crítico ou alto. A chave do limite usa só o `driverId` devolvido por `authorizeDriver`, o limite roda antes de ler o corpo nas 4 rotas e o 429 não vaza nada. Um motorista não consegue mexer no contador de outro. Ficaram 3 achados médios: um motorista autenticado ainda gasta 1 comando do Upstash por requisição barrada (é a autenticação, não o limitador); o teto conta requisições, não o custo de cada uma; e o contrato chama de limitador de custo do A2A algo que só conta falhas. Há também 4 achados baixos.

| # | Sev. | Título | Onde |
|---|---|---|---|
| M1 | Médio | Requisição barrada pela rajada ainda gasta 1 comando do Upstash (autenticação): um motorista em loop esgota a cota e derruba todos | `src/lib/auth.ts:244-247`, `src/lib/driver/session-token.ts:109`, `src/lib/ai-limits.ts:138-140` |
| M2 | Médio | O teto é por requisição; o custo de cada uma não tem teto barato (transcript sem limite, áudio de até 10 MB, TTS com 2 chamadas) | `src/app/api/orchestrator/route.ts:26`, `src/app/api/realtime/transcribe/route.ts:8,74`, `src/app/api/realtime/tts/route.ts:126-140` |
| M3 | Médio | O contrato diz que o A2A "já tem limitador próprio", mas `guardA2A` só conta falhas: um token A2A válido faz chamadas de LLM sem teto | contrato:55, `src/lib/auth.ts:92-139`, `src/app/api/agents/[agent]/route.ts:10-16` |
| B1 | Baixo | A falha aberta do dono pega qualquer exceção, não só o Redis fora (inclui store não configurado) | `src/lib/ai-limits.ts:143-149`, `src/lib/driver/index.ts:28-29` |
| B2 | Baixo | `cls in AI_LIMITS` aceita chave do protótipo (`"constructor"`): sem limite (inalcançável hoje) | `src/lib/ai-limits.ts:69,73,102,151` |
| B3 | Baixo | O teto do dia é por `driverId`: um convite com `--max-uses N` multiplica a cota de quem tem o código | `scripts/lib/admin-cli.mjs:16,184`, `src/lib/ai-limits.ts:72-77` |
| B4 | Baixo | Um `console.warn` por 429: cliente em loop gera uma linha de log por requisição | `src/lib/ai-limits.ts:108` |

---

## Achados

### M1 (médio): requisição barrada pela rajada ainda gasta 1 comando do Upstash; um motorista em loop esgota a cota de todos

**Fato.**
- As 4 rotas chamam `authorizeDriver` antes do limite: `src/app/api/orchestrator/route.ts:9-13`, `src/app/api/realtime/transcribe/route.ts:11-15`, `src/app/api/realtime/tts/route.ts:72-76`, `src/app/api/realtime/session/route.ts:21-32`.
- Para sessão `v1.`, `authorizeDriver` faz `authenticateSession`, e ela faz `store.getDriver` (`src/lib/auth.ts:244-247`, `src/lib/driver/session-token.ts:109`). No Upstash isso é 1 `HGETALL` (`src/lib/driver/upstash-store.ts:190-192`).
- A rajada não toca no Redis (`src/lib/ai-limits.ts:138-140`), mas a requisição já gastou o `HGETALL` antes. A rajada não limita **quantas** requisições chegam; ela só decide a resposta.

**Cenário.** Um convidado com sessão válida (ou alguém com o token de 90 dias vazado) manda requisições em loop para `/api/orchestrator`. Cada uma recebe 429 `burst` sem chamar o serviço pago, mas custa 1 comando do Upstash e uma invocação da Vercel. A cota do plano Free acaba. Daí em diante, **todos** os motoristas recebem 503 de `authorizeDriver`: é negação de serviço entre motoristas. Com o id legado, o dono também entra na janela de falha aberta (ver B1 e o item 4 abaixo).

**Hipótese (ordem de grandeza).** Com a cota do Free na casa de centenas de milhares de comandos por mês, 100 req/s esgotam a cota em poucas horas. O número exato do plano não foi verificado.

**Relação com o contrato.** A linha 100 (Histórico) diz que "cada requisição barrada gasta um comando do Upstash" e que a mudança evita isso. Isso vale só para o limitador. O custo da autenticação continua. O débito 14 de `docs/ESTADO_ATUAL.md:75` trata só do `POST /api/session` sem autenticação.

**Recomendação.**
- A regra de firewall da A3 deve cobrir também `/api/orchestrator` e `/api/realtime/*` (por IP, acima do uso normal: algo como 60/min), não só `/api/session` e o callback. O alerta de uso no Upstash continua obrigatório.
- Opcional, barato e sem Redis: uma rajada pré-autenticação por instância, com chave `sha256(bearer)` (nunca o bearer em claro), aplicada antes de `authorizeDriver`. Ou um cache curto (5 a 10 s) de `getDriver` por instância. As duas reduzem o custo do loop, mas nenhuma substitui a A3.

### M2 (médio): o teto conta requisições; o custo de cada requisição não tem teto barato

**Fato.**
- `/api/orchestrator`: `transcript` não tem tamanho máximo (`src/app/api/orchestrator/route.ts:26`) e vai inteiro para o fan-out de agentes (`src/orchestrator/orchestrate.ts:126-150`), com até uma chamada de LLM por agente.
- `/api/realtime/transcribe`: aceita até 10 MB de áudio (`src/app/api/realtime/transcribe/route.ts:8,74,99`) com `mimeType` escolhido pelo cliente (linha 68). Em opus/webm, 10 MB dão dezenas de minutos de áudio. Na Vercel o corpo é limitado antes disso (hipótese: 4,5 MB), o que ainda dá vários minutos por requisição.
- `/api/realtime/tts`: uma requisição contada pode fazer 2 chamadas à OpenAI (`src/app/api/realtime/tts/route.ts:126-140`, fallback para `tts-1`) e até 8 ao Google (linhas 150-160).
- O contrato chama o teto do dia de "a garantia de custo" (contrato:25), mas põe "custo por token ou por segundo de áudio" fora de escopo (contrato:87).

**Cenário.** Um convidado malicioso faz 600 transcrições por dia com o maior áudio aceito e 600 turnos com `transcript` de megabytes. O teto de requisições é respeitado, mas o custo por motorista fica muito acima do raciocínio do contrato ("um turno a cada 20 s durante 3 horas"). Multiplique por até 26 motoristas. **Hipótese:** dezenas de dólares por dia por motorista com STT da OpenAI. Os preços não foram verificados.

**Recomendação (antes dos convites, decisão do dono).** Tetos baratos por requisição, que não dependem de medir tokens:
- `transcript` de no máximo cerca de 1 a 2 mil caracteres (a voz não produz mais que isso num turno);
- áudio de no máximo cerca de 1 MB, ou duração máxima por `mimeType`;
- sem fallback duplo de TTS para quem não é dono (ou contar o fallback como uma segunda unidade).

Também vale ajustar a frase do contrato para "garantia de número de requisições".

### M3 (médio): o A2A não tem teto de custo, ao contrário do que diz o contrato

**Fato.**
- O contrato (linha 55) diz: "`POST /api/agents/[agent]` (A2A) já tem limitador próprio". Mas `guardA2A` (`src/lib/auth.ts:92-139`) conta só tentativas **falhas** por IP. O segredo certo passa sem contar nada (linhas 123-131).
- A rota executa os agentes (LLM da Neuralake) como dono (`src/app/api/agents/[agent]/route.ts:10-16`, `src/lib/a2a-server.ts:42-45`) e não chama `enforceAiLimit`.
- Hoje o A2A está desligado: `FINN_A2A_TOKEN` não existe na Vercel (`docs/ESTADO_ATUAL.md:43`). Isso não foi verificado no painel.

**Cenário.** Quando o A2A for ligado, um `FINN_A2A_TOKEN` vazado permite chamadas de LLM sem teto de rajada nem de dia. A regra de `ESTADO_ATUAL.md:43` pede "limite de taxa em Redis ou Firewall" antes de criar a variável, e o limitador de falhas pode ser confundido com esse limite.

**Recomendação.** Corrigir a linha 55 do contrato ("limitador de **falhas**, não de custo"). Antes de criar `FINN_A2A_TOKEN`, chamar `enforceAiLimit` no A2A depois de `guardA2A`, com o id do dono e uma classe própria (`a2a`) ou `orchestrator`. Isso não bloqueia convites; bloqueia ligar o A2A.

### B1 (baixo): a falha aberta do dono pega qualquer exceção

**Fato.** O `catch` de `src/lib/ai-limits.ts:143-149` envolve `getDriverStore()` e `incrementRateLimit`. Ele trata como "Redis fora" também:
- o store não configurado em produção (`resolveDriverBackend` lança: `src/lib/driver/index.ts:28-29`);
- erros de validação (`validateWindowSeconds`, `keys.rateLimit`).

Com `FINN_LEGACY_TOKEN_ENABLED=1` e sem `FINN_OWNER_DRIVER_ID`, a autenticação do dono não toca no store (`src/lib/auth.ts:183-184, 232-238`). Num deploy sem `KV_REST_API_*`, o teto de dia do dono fica desligado **para sempre**, e o único sinal é um `console.warn` por requisição.

**Cenário.** Erro de configuração (variável do Upstash apagada) somado ao token legado vazado dá custo sem teto de dia. Sobra só a rajada por instância.

**Recomendação.** Falhar aberto só com `err instanceof DriverStoreUnavailableError`. Qualquer outro erro dá 503 também para o dono. Teste: store que lança `Error("Invalid windowSeconds")` com o dono dá 503.

### B2 (baixo): chave de protótipo passa no `cls in AI_LIMITS`

**Fato, conferido com `node -e`.** `"constructor"` casa `CLASS_RE` (`src/lib/ai-limits.ts:69`) e `"constructor" in AI_LIMITS` é `true` (linha 73). A chave `ratelimit:ai:constructor:...` é montada, mas `AI_LIMITS[cls].burst` e `.day` ficam `undefined`, e `count > undefined` é sempre `false` (linhas 102 e 151): a requisição nunca seria limitada.

**Hoje é inalcançável:** as 4 chamadas passam literais tipados (`grep enforceAiLimit(`). O critério do contrato ("classe com caractere inválido nunca vira chave") só é coberto pelo teste com `"../../x"` (`tests/acceptance/ai-limits.test.ts:380`).

**Recomendação.** Trocar por `Object.hasOwn(AI_LIMITS, cls)` e testar com `"constructor"`.

### B3 (baixo): o teto do dia é por `driverId`, e cada resgate de convite cria um `driverId`

**Fato.** O padrão é 1 uso por convite (`scripts/lib/admin-cli.mjs:16`), mas `--max-uses N` é aceito (linha 184). Cada resgate cria um motorista novo, com contador próprio. Quem tem o código de um convite de N usos consegue N vezes a cota (respeitado o limite de resgate por IP). O contrato põe o "limite global somado" fora de escopo (linha 87).

**Recomendação.** Documentar no roteiro de convites: "um convite por convidado, `--max-uses 1`". Se o dono quiser convite de grupo, considerar um teto global diário depois.

### B4 (baixo): uma linha de log por 429

**Fato.** `tooMany` loga em todo estouro (`src/lib/ai-limits.ts:108`). Sem dado sensível: só classe e escopo. Um cliente em loop gera uma linha por requisição, o que aumenta o volume de logs da Vercel e esconde outros sinais.

**Recomendação.** Logar uma vez por janela de rajada por chave (o mapa já tem a entrada; um booleano `logged` basta), ou por amostragem.

---

## Pontos pedidos, um a um

### (1) Ordem e cobertura das rotas (Fato)

| Rota | Serviço pago? | Limite | Ordem |
|---|---|---|---|
| `POST /api/orchestrator` | Sim (LLM via agentes) | `orchestrator` | `authorizeDriver` (l.9), limite (l.12), corpo (l.17) |
| `POST /api/realtime/transcribe` | Sim (Groq/OpenAI) | `stt` | auth (l.11), limite (l.14), 413 por cabeçalho (l.17), corpo (l.58/87) |
| `POST /api/realtime/tts` | Sim (OpenAI, Google) | `tts` | auth (l.72), limite (l.75), 413 (l.79), corpo (l.85) |
| `POST /api/realtime/session` | Sim (OpenAI Live) | `live` | auth (l.21), `ENABLE_GPT_LIVE` (l.24), limite (l.31), corpo (l.36) |
| `POST /api/agents/[agent]` | Sim (LLM) | **Só falhas** (`guardA2A`) | ver M3 |
| `GET /api/agents/[agent]/card` | Não | Nenhum (público, estático) | — |
| `POST/GET /api/session` | Não | Resgate por IP (Redis) | fora do M3 |
| `POST /api/spotify/connect` | Não | `ratelimit:spotify-connect:<driverId>` | fora do M3 |
| `GET/DELETE /api/spotify/connection`, `GET /api/spotify/login`, `GET /api/spotify/callback` | Não (API do Spotify) | Próprios ou nenhum | fora do M3 |

Não há Server Actions (`"use server"`) nem `route.ts` fora de `src/app/api`. Os clientes pagos (`getNeuralakeClient`, `api.openai.com`, `api.groq.com`) só são chamados pelas 4 rotas acima e pelos agentes (orquestrador e A2A).

### (2) Chave (Fato)

A chave vem de `auth.driverId` nas 4 rotas e nunca do corpo. `aiDayKey` (`src/lib/ai-limits.ts:72-77`) exige classe `[a-z]{1,20}` presente no mapa (ver B2), dia `\d{8}` e `isValidDriverId` (`drv_` + 22 caracteres base64url, `src/lib/driver/store.ts:66`). O pior caso tem 51 caracteres depois de `ratelimit:`, dentro do teto de 100 de `RATE_KEY_RE` (`store.ts:90`).

Não há colisão:
- o `driverId` não contém `:`, então os segmentos não se confundem;
- o prefixo `ratelimit:ai:` não colide com `ratelimit:redeem:`, `ratelimit:a2a:` nem `ratelimit:spotify-connect:`;
- classes e dias ficam em segmentos fixos.

Uma chave inválida dá 503 antes de qualquer contagem (linhas 132-136).

### (3) Contornos

- **Dois aparelhos `v1.` do mesmo motorista:** compartilham o contador, porque a chave é o `driverId`. É o esperado.
- **Token legado:** mapeia para `getOwnerDriverId()` (`auth.ts:232-238`) e é contado como dono, com os mesmos tetos.
- **Concorrência:** o dia usa `INCR` atômico num `EVAL` (`upstash-store.ts:76-79, 365-371`). N requisições paralelas no limite deixam passar exatamente uma. A rajada é síncrona antes do primeiro `await` (`ai-limits.ts:128-140`), sem corrida dentro da instância.
- **Rajada por instância:** com K instâncias, a rajada efetiva é K×20/min. O teto do dia é global (Redis), então o custo diário por motorista continua em 600 por classe (e 30 no `live`). A rajada só muda a velocidade em que se chega lá. Aceito pelo contrato.
- **Virada do dia:** no pior caso, o dobro do teto perto da meia-noite de São Paulo. Aceito (decisão 2).
- **Relógio e `Intl`:** `hourCycle: "h23"` evita a hora "24". O dia sai do relógio da instância. São Paulo não tem horário de verão hoje; se voltar, só o `Retry-After` erra em até 1 h, porque o cálculo assume um dia de 86400 s (`ai-limits.ts:63-66`). **Hipótese:** se o runtime não tivesse ICU com fusos, o `Intl.DateTimeFormat` lançaria ao carregar o módulo, as 4 rotas dariam 500 e o sistema falharia fechado.

### (4) Falha aberta do dono

- **Um atacante sem o token do dono consegue abrir a porta de outro motorista?** Não (Fato). Para quem não é dono, o `catch` devolve 503 (`ai-limits.ts:146`). `isOwner` compara o `driverId` provado com o id do dono por igualdade exata (`auth.ts:190-194`).
- **`isOwner` pode ser verdadeiro para quem não é dono?** Não (Fato). O id do dono vem só de `FINN_OWNER_DRIVER_ID` (válido e diferente do legado) ou, com a flag, de `LEGACY_OWNER_DRIVER_ID` (`auth.ts:164-176`). O `driverId` de uma sessão `v1.` exige assinatura HMAC e um registro ativo no store com o mesmo `sub` (`session-token.ts:107-110`). O id legado não tem registro, então nenhuma sessão `v1.` produz esse id, e um convite gera ids aleatórios.
- **Provocar a queda do Redis:** sim, um atacante consegue, inclusive sem autenticação (cota do Upstash via `/api/session`, ou via M1 com uma sessão). O efeito é: todos os motoristas recebem 503 (fechado) e o teto de dia do dono abre. Isso só é explorável com o token do dono. Na prática a janela é estreita:
  - com `FINN_OWNER_DRIVER_ID` real e Redis inteiro fora, a própria autenticação do dono já dá 503 (`auth.ts:183-186, 238-240`);
  - a falha aberta só é alcançável com o id legado (dono sem registro) ou numa falha parcial (o `HGETALL` funciona e o `EVAL` dá timeout).
  - Ver também B1.

### (4b) A rajada não tocar no Redis

Não abre vetor entre motoristas (Fato): a rajada e o dia usam o `driverId` provado, e nada que um motorista faz incrementa a chave de outro. O efeito colateral real é o M1: o custo de autenticação continua.

### (5) Negação de serviço

- **Mapa de rajada:** a chave é `driverId:classe`, ou seja, no máximo 4 entradas por motorista. Para encher 1000 entradas são precisos cerca de 250 motoristas **ativos**. Um motorista não consegue fazer isso com sessões próprias, porque sessões do mesmo motorista compartilham a chave. Com até 25 convidados e o dono, o mapa fica em cerca de 104 entradas.
- **Se fosse possível encher o mapa:** a remoção da entrada mais antiga zera a rajada da **vítima**, o que beneficia a vítima, não o atacante. O atacante só ganharia se expulsasse as próprias entradas, o que exige os mesmos 250 ids, e o dia continua valendo.
- **Memória:** limitada a 1000 entradas pequenas (Fato, teste em `tests/acceptance/ai-limits.test.ts:396`).
- **Chaves no Redis:** só motorista autenticado cria chave (401 não cria). Com TTL de 25 h, ficam no máximo cerca de 2 dias × 4 classes × 26 motoristas, ou seja, umas 200 chaves.
- **Comandos do Upstash:** 1 `EVAL` por requisição que passa da rajada, mais o custo da autenticação em toda requisição (M1).
- **Entre motoristas:** a degradação real é via cota do Upstash (M1).

### (6) Vazamento (Fato)

- Corpo do 429: `{ error: "Too many requests", scope }` (`ai-limits.ts:109-112`), sem contagem, teto nem id.
- `Retry-After`: segundos até o fim da janela da rajada, ou até a meia-noite de São Paulo. Não revela dado de terceiros.
- `Cache-Control: no-store` no 429 e no 503.
- Logs do módulo: `[ai-limit] <classe> over <escopo> limit` e `[ai-limit] <classe> day counter unavailable`, sem id, chave nem contagem. O erro do store não é logado: `DriverStoreUnavailableError` não carrega causa (`upstash-store.ts:141-147`). As 4 rotas não acrescentaram logs. Os logs de erro de upstream que já existiam (`transcribe/route.ts:135`, `tts/route.ts:184`, `session/route.ts:71`) estão fora do diff.

### (7) `MAX_RATE_WINDOW_SECONDS` de 86400 para 90000 (Fato)

É só o teto do validador (`store.ts:139,170-172`). Os outros chamadores passam constantes de 600 s: resgate (`invite.ts:58,60,116`), A2A (`auth.ts:83-84,134`) e Spotify connect (`connect.ts:24,58`). Nenhum chamador passa janela vinda do cliente e nenhum script usa `incrementRateLimit`. Nenhum limitador ficou mais frouxo.

### (8) PWA (Fato, por leitura e testes)

- **`classifyServerFailure`** (`src/lib/voice/failure-speech.ts:26-79`):
  - lê o corpo só no 429, com teto de 1 KB e `reader.cancel()`, e prazo de 1,5 s com `clearTimeout` no `finally`;
  - `try/catch` total, então não lança;
  - `JSON.parse` não cria getters, e `{"__proto__":{...}}` vira propriedade própria, então `body.scope` fica `undefined`;
  - comparação estrita `=== "day"`;
  - o `Promise.race` assina o `read`, então uma rejeição tardia não fica sem tratamento.
  - Corpo infinito, grande, truncado, não-JSON e erro no meio da leitura estão cobertos (`failure-speech.test.ts`).
- **Texto falado:** sempre de `LOCAL_SPEECH`, nunca do servidor.
- **Logs:** `console.warn` só com tipo de falha e status (`delegation-handler.ts:69`). O erro do Live leva só o status (`live-session.ts:123`). Nenhum token, `driverId` ou corpo vai para console ou DOM.
- **Fora de segurança:**
  - em `stt-tts-session.ts:313-324` não há nova checagem de `closed`/`reqId` depois do `await classifyServerFailure` (até 1,5 s), então a fala local pode sair depois de a sessão fechar;
  - o 429 do TTS não usa a fala do dia (`stt-tts-session.ts:456`), porque cai na voz nativa, o que já é conhecido e aceitável.

### (9) O que continua fora

O contrato deixa claros:
- a A3 (limite por IP e força bruta de Bearer/`FINN_API_TOKEN`);
- a saída do `FINN_API_TOKEN` depois da virada;
- o custo por token ou por segundo de áudio;
- o limite global somado e a rajada entre instâncias.

O contrato não deixa claros:
- o custo de autenticação por requisição barrada (M1);
- que o limitador do A2A é só de falhas (M3).

A comparação do token legado usa digest de tamanho fixo e `timingSafeEqual` (`auth.ts:14-16, 215`). A força bruta continua sem limite, como a A3 já registra.

### (10) Redis fora para motorista (Fato)

- Com Redis inteiro fora, `authorizeDriver` já dá 503 (`auth.ts:248-250`).
- Numa falha parcial (o `EVAL` falha), `enforceAiLimit` dá 503 antes de qualquer serviço (`ai-limits.ts:146`). O teste está em `tests/acceptance/ai-limits.test.ts:283`.
- Se a rajada estourou, a resposta é 429 `burst` sem tocar no Redis, o que é coerente com o contrato.

---

## Comandos rodados

- `npx vitest run --no-cache tests/acceptance/ai-limits.test.ts src/lib/voice/failure-speech.test.ts src/lib/voice/orchestrator-client.test.ts src/lib/voice/delegation-handler.test.ts src/lib/voice/stt-tts-session.test.ts src/lib/voice/voice-controller.test.ts src/lib/driver/hardening.test.ts src/app/api/orchestrator/route.test.ts`: **8 arquivos, 216 testes passaram, 0 falharam.** `git status --porcelain` vazio antes e depois.
- `node -e` com um objeto literal para confirmar o comportamento de B2 (`"constructor" in o === true`, limite `undefined`, comparação `false`).
- Nenhuma mutação (é tarefa do qa, numa cópia fora do repositório). O lote completo (`npm test && npm run typecheck && npm run lint`) não foi rodado.

## Não verificado

- O `EVAL` com TTL 90000 no Upstash real e os números reais da cota do plano Free (M1).
- O comportamento da Vercel: número de instâncias sob carga, limite real do corpo da requisição (o 4,5 MB citado em M2 é hipótese) e ICU/fusos do runtime.
- Preços de Neuralake, Groq e OpenAI (a ordem de grandeza em M2 é hipótese).
- Se `FINN_A2A_TOKEN` está mesmo ausente na Vercel (M3; usei `docs/ESTADO_ATUAL.md:43`).
- PWA em iPhone real e o corpo real do 429 de produção.
- A cobertura de regra de firewall da A3 (ação do dono, ainda inexistente).

## Isto bloqueia convites em produção?

**Nada do M3, por si, bloqueia convites.** Não há achado crítico nem alto, e as invariantes 1 a 6 do contrato se sustentam no código.

O que precisa estar resolvido antes de abrir convites:
- **M1** depende da A3, que já é bloqueio de convites. Ao escrever a regra de firewall, ela deve cobrir também as rotas de IA autenticadas, e o alerta de uso do Upstash precisa existir.
- **M2:** recomendo os tetos baratos por requisição (tamanho do `transcript` e do áudio) antes dos convites. A decisão é do dono, porque o contrato aceitou o custo por requisição fora de escopo.
- **M3** bloqueia ligar o A2A, não os convites.
- **B1 a B4** podem ficar para depois do merge.
