# QA: limites por motorista nas rotas de IA (M3)

Branch `feat/ai-rate-limits`, diff `2fdcee1..HEAD` (HEAD 88fac6c). Contrato: `docs/contratos/limites-por-motorista.md`. Revisor: qa (Sonnet). Todas as mutações e ataques rodaram numa cópia fora do repositório; a árvore não foi alterada. Esta é a única gravação no repositório (não commitada).

## 1. Veredito

Nenhum bloqueante. O código novo se comporta como o contrato pede em todos os ataques tentados. Há 8 achados não bloqueantes (um deles muda a premissa do contrato sobre o dono) e lacunas de teste mostradas por mutações sobreviventes.

## 2. Testes rodados e contagens

- Lote na cópia idêntica ao HEAD: `npm test`: 59 arquivos passaram, 1 pulado; 1244 testes passaram, 4 pulados, 0 falharam. `npm run typecheck`: exit 0. `npm run lint`: exit 0.
- Afetados: `npx vitest run tests/acceptance/ai-limits.test.ts src/lib/voice src/lib/driver src/app/api`: 26 arquivos, 521 passaram. `tests/acceptance/ai-limits.test.ts` sozinho: 68 passaram.
- Meus ataques (cópia, código sem mutação): `tests/qa/m3-attacks.test.ts` 46, `m3-pwa.test.ts` 12, `m3-live.test.ts` 4: 62 passaram. Guardados em `/private/tmp/claude-501/-Users-joaopedropanzamainieri-JP-Projetos-finn/49cb48c2-d2e7-478f-b0d5-d17b5e72d1b9/scratchpad/m3-qa-artifacts/` (com `m3mut.py`, o script das mutações). A cópia do repositório foi apagada.
- `npm run build`: NÃO verificado (ver seção 7).

## 3. Mutações (63 reais mais 1 controle)

47 no servidor (M01 a M47) e 16 no PWA (P01 a P16), mais P17, que é um controle sem mudança (sobreviveu, como deve). Cada mutação rodou contra o conjunto afetado do repositório e depois contra os meus ataques.

- Mortas pelos testes do repositório: 51 de 63 (servidor 40 de 47, PWA 11 de 16).
- Mortas só pelos meus ataques: 9 (M20, M24, M32, M33, M45, M46, P03, P09, P15).
- Nenhum teste mata: 3. M19 (`Math.max(0, ...)` no `Retry-After`) e P11 (tirar o `typeof scope === "string"`) são equivalentes: `remaining` nunca é menor que 1 e a comparação estrita `=== "day"` descarta não-string. P10 é lacuna real (ver N6).

Mortas pelo repositório (as que o contrato lista estão entre elas): remover o limite em cada uma das 4 rotas (M01 a M04), `live` com limite antes do `ENABLE_GPT_LIVE` (M05), chave vinda de cabeçalho `x-driver-id` em cada rota (M06 a M09), chave vinda do corpo (`driverId` ou `contextId`) em cada rota (M36 a M39), limite antes de `authorizeDriver` em 4 rotas (M40 a M43), 429 chamando o serviço (M44), incrementar o dia antes da rajada (M10), falhar aberto para motorista (M11), falhar fechado para dono (M12), TTL 3600 (M13), fuso UTC (M14), `>` por `>=` no dia (M15) e na rajada (M16), `scope` trocado nos dois sentidos (M17, M18), `Retry-After` sem teto 86400 (M21), mapa com 1001 por `>` (M22), sem varredura de vencidas (M23), janela da rajada 30 s (M25), 429 sem `no-store` (M26), corpo do 429 com contagem (M27), log com `cause` (M28, M47), teto do store 86400 (M29) e 100000 (M30), chave sem `isValidDriverId` (M31), dono sempre isento do dia (M34), chave inválida deixando passar (M35); no PWA: `includes` no lugar de `===` (P01), sem teto de 1 KB (P02), 503 lendo o corpo (P04), fala genérica no transcribe (P05), no orquestrador (P06), no handler de delegação (P07) e na saudação (P08), `String(scope)` (P12), `toLowerCase` (P13), `trim` (P14), ler o corpo em 500 (P16).

Sobreviventes do repositório (7 no servidor e 5 no PWA, 3 sem nenhuma morte):
- M20 `floor` em vez de `ceil` no `Retry-After`: nenhum teste do repositório fica a milissegundos da meia-noite (só segundos exatos).
- M24 chave da rajada sem a classe (`driverId` em vez de `driverId:classe`): nenhum teste prova que as classes têm rajada independente.
- M32 renovação da janela sem `delete` e M33 eviction do mais novo em vez do mais antigo: o teste do mapa só confere o tamanho, nunca quem sai.
- M45 e M46: o 503 do motorista é testado com `Error` genérico, nunca com `DriverStoreUnavailableError` (o tipo real do Upstash); o teto do mapa é testado contra a própria constante, não contra o literal 1000.
- P03 (sem prazo de 1,5 s): equivalente para streams cooperativos (o temporizador ainda chama `cancel`); morre só com `cancel()` que nunca resolve. P15 (sem `cancel` no corpo grande): só fecha conexão.
- P09 (`live-session` lança `RateLimitedError` para `day`) e P10 (mensagem do `connect-failed` no `VoiceController` para `DayLimitedError`): não há teste algum. `GptLiveSession` não tem arquivo de teste. O comportamento está certo (meu `m3-live.test.ts` mata P09; P10 só por leitura de código).

## 4. Achados

### Bloqueantes
Nenhum.

### Não bloqueantes
N1. **A falha aberta do dono quase nunca roda em produção.** Com `FINN_OWNER_DRIVER_ID` real, o token legado e a sessão `v1.` do dono passam por `getDriver` na autenticação. Com o Redis fora, `authorizeDriver` devolve 503 antes do limite. Reproduzido: store com `getDriver` e `incrementRateLimit` caindo, token legado, as 4 rotas: 503. O dono só passa quando o id é o provisório (`drv_legacy_owner_000000000`) ou quando só o `EVAL` falha. O teste do repositório "owner passes" derruba só `incrementRateLimit`, não representa queda do Upstash. A premissa do contrato ("o app do carro do dono não cala numa queda") vale apenas antes da virada do dono. Decisão para o dono: aceitar, ou documentar.
N2. **Eviction da rajada (a sua hipótese): confirmada em tese, risco baixo.** Reproduzido em `m3-attacks.test.ts`: o atacante gasta 20 de 20, entram 1000 outras chaves `motorista:classe` na mesma janela de 60 s, a entrada dele sai (a mais antiga), e ele passa mais 20. Exige 1000 chaves distintas em uma instância em 60 s (um motorista gera no máximo 4, uma por classe; seriam 250 motoristas ativos). O contador do dia no Redis sobrevive à eviction: 40 ondas deixaram o dia acima de 600 e a requisição seguinte deu 429 `day`. O custo continua limitado pelo teto do dia.
N3. **Um `console.warn` por 429, sem teto de taxa.** Uma rodada de teste com 4 rotas gerou 107 linhas. Cliente em loop produz uma linha por requisição barrada (até milhares por minuto), e o log não tem id para rastrear. Cumpre "um aviso por estouro", mas é amplificação de log.
N4. **A requisição barrada pela rajada ainda custa 1 comando do Upstash.** `authenticateSession` faz `getDriver` (1 `HGETALL`) em toda requisição `v1.` antes do limite. A mudança de ordem leva o custo de 2 comandos para 1, não para 0. O relatório e o contrato falam de "nenhum comando" só do limitador. O freio real de IP continua sendo A3.
N5. **Redis lento: sem trava, mas a latência soma.** Cliente com timeout de 2 s (`createRedisClient`): o motorista espera até 2 s na autenticação mais até 2 s no limite (serial), e então 503 (a PWA fala "fora do ar" localmente). O dono com id provisório paga 2 s por requisição e passa. Não há disjuntor: toda requisição paga o timeout de novo. Medido com timeout de 300 ms: 503 em ~302 ms.
N6. **Lacunas de teste (seção 3):** `Retry-After` a milissegundos da meia-noite, independência da rajada por classe, ordem de eviction, 503 com o tipo real do store, literal 1000 do mapa, caminho do `live` e do `connect-failed` no PWA para `day`.
N7. **Horário de verão:** `secondsToMidnight` usa a hora local do dia. Sem horário de verão desde 2019 está certo (fuzz de 300 mil instantes de abril/2019 a 2045 contra UTC-3 fixo: 0 divergências). Se o Brasil o restaurar, o `Retry-After` erra 1 h só no dia da troca; a chave do dia não é afetada. Em fev/2019 (ainda com horário de verão) o teste divergiu 3600 s, o esperado.
N8. **PWA atrasa a fala até 1,5 s** quando o corpo do 429 é lento ou nunca termina (medido 1501 ms; sem `unhandledRejection`; mesmo com `cancel()` pendente para sempre). O servidor real responde na hora. O TTS em 429 (dia) cai na voz nativa sem frase própria; é consistente, pois `stt` e `orchestrator` têm o mesmo teto e já falam a frase.

## 5. O que foi atacado e o resultado

1. Ordem e fronteiras: 401 (sem token, `v1.` inválido, motorista revogado, `rotateSessions`) não toca contador nem o mapa, nas 4 rotas. `session` desligada: 403 sem contar. Rajada no teto passa e teto+1 dá 429; dia no teto passa e teto+1 dá 429.
2. Relógio: ICU 78.2 no Node 24.14, `America/Sao_Paulo` resolve e dá UTC-3 (não cai em UTC). 23:59:59.999 devolve dia anterior e `Retry-After` 1; 00:00:00.000 devolve o dia novo e 86400; +1 ms ainda 86400; +1000 ms 86399. `Retry-After` do dia sempre inteiro entre 1 e 86400 (fuzz). Rajada de 1 a 60.
3. Concorrência: 20 requisições simultâneas com o dia a 5 do teto, store com atraso aleatório, nas 4 classes: passam exatamente as restantes. Dois motoristas em paralelo não se afetam. A rajada é síncrona antes do primeiro `await`, sem corrida.
4. Mapa: nunca passa de 1000, vencidas somem, evict do mais antigo (ver N2).
5. Corpo, cabeçalho e cookie forjados nunca viram chave nas 4 rotas (teste do repositório mais mutações M06 a M09 e M36 a M39).
6. Dono: token legado e `v1.` do dono compartilham o contador. Redis fora: dono (id provisório) passa só no dia e a rajada vale; motorista 503 (ver N1).
7. Logs: varredura que expande message, stack e cause sobre todos os caminhos (inclusive Redis caindo com id e chave na mensagem e no cause): nenhuma linha fora do padrão `[ai-limit] <classe> over (burst|day) limit` ou `day counter unavailable`; nenhum id, chave, dia ou contagem.
8. `MAX_RATE_WINDOW_SECONDS` 86400 para 90000: os outros chamadores (convite, A2A, Spotify connect) usam janelas de 600 s; só afrouxa a validação. 90000 aceito e 90001, 0, 1.5, NaN, Infinity, negativo recusados (memória e Upstash fake). M29 e M30 provam as duas bordas. Nenhum outro uso no código nem nos scripts.
9. PWA: corpo grande (1024 bytes exatos com `day` vale; 1025 não), stream infinito de pedaços pequenos (cancelado rápido), `cancel()` pendente, nunca termina, erro no meio, JSON parcial, `__proto__` e `constructor` aninhados, `scope` array, objeto ou com Unicode homoglifo, `DAY`, corpo com `body` getter que lança: tudo cai em "muitas tentativas" sem lançar. `scope: "day"` em 503 dá "fora do ar"; em 403, 500, 502, 200, 401 e 404 não vira falha. A frase do dia é constante local; nada do corpo é falado. `GptLiveSession` (stub de WebRTC): `day` vira `DayLimitedError`, `burst` vira `RateLimitedError`, 503 com `scope: "day"` vira `UnavailableError`, 403 não vira `DayLimitedError`.
10. Regressão: ver seção 2.

## 6. Decisões para o dono
- N1: aceitar que a falha aberta do dono só vale antes da virada do dono (ou com o id provisório), ou ajustar a promessa do contrato.
- N3 e N4: se o log por 429 e o 1 comando de autenticação por requisição barrada preocupam antes do beta (A3 cobre IP e firewall).

## 7. Não verificado
- Upstash real: `EVAL` com TTL 90000 só rodou no store em memória e no fake; Vercel (runtime, Node usado, cold start real, várias instâncias): nada.
- Rajada entre instâncias (é por instância, por contrato) e comportamento sob carga real.
- iPhone, voz com microfone aberto, fala nativa em iOS, WebRTC real do `live`.
- `npm run build`: o Turbopack falhou nas minhas cópias com erros de resolução de módulo em `node_modules` (`@vercel/turbopack/postcss`, `@swc/helpers`), que não têm relação com o diff; `next build --webpack` compilou e parou no type-check por exports de `route.ts` que já existem no commit base (`splitIntoTtsChunks`, `MAX_BODY_BYTES`). Os relatórios dos implementadores dizem build ok; eu não o reproduzi. O orquestrador deve rodá-lo na árvore real.
- O caminho do `VoiceController.connect` para `DayLimitedError` (P10) só por leitura.
- Comportamento com o horário de verão restaurado.
- Observação de processo: a pasta `qa` do scratchpad da sessão já existia (resto de revisão anterior) e foi sobrescrita ao criar a cópia.
