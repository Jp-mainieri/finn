# Relatório: limites por motorista nas rotas de IA, servidor (M3)

Agente: api (Sonnet). Branch `feat/ai-rate-limits`. Contrato: `docs/contratos/limites-por-motorista.md`. Sem push, sem merge.

## O que mudou
- `src/lib/ai-limits.ts` (novo): `AI_LIMITS` (stt/orchestrator/tts 20 por min e 600 por dia; live 5 e 30), `enforceAiLimit(classe, driverId)`, rajada em memória (janela 60 s, máx. 1000 entradas, varredura das vencidas ao encher, sem timers), dia no Redis via `incrementRateLimit` com chave `ratelimit:ai:<classe>:<AAAAMMDD>:<driverId>` e TTL 90000, dia em `America/Sao_Paulo` por `Intl`. Ganchos de teste: `resetAiLimitsForTests(relógio)`, `burstEntryCountForTests`.
- 4 rotas chamam o helper logo após `authorizeDriver` (em `session`, após `ENABLE_GPT_LIVE`), antes de ler corpo.
- `src/lib/driver/store.ts`: `MAX_RATE_WINDOW_SECONDS` 86400 para 90000 (ver desvios); `hardening.test.ts` ajustado (limite testado 90001).
- Testes: `tests/acceptance/ai-limits.test.ts` (64 testes, 4 rotas); `tests/helpers/harness.ts` zera a rajada por teste; `src/app/api/orchestrator/route.test.ts` ganhou `isOwner` no mock de auth.
- Docs: ARCHITECTURE (tabela de rotas) e ESTADO_ATUAL (débito 16 resolvido, tetos e onde mudar).

## Comandos e contagens
`npm test` (após o ajuste de ordem): 59 arquivos passaram, 1 pulado; 1211 testes passaram, 4 pulados (antes do ajuste: 1206). `npm run typecheck`, `npm run lint`, `npm run build`: sem erros. Rodados uma vez, no fim.

## Mutações (cópia fora do repositório, scratchpad; árvore intocada)
Mataram: remover o limite de orchestrator, stt, tts e live (11 a 12 testes cada); chave por `contextId` no orchestrator (1 teste); limite antes de `authorizeDriver` (12); falhar aberto para motorista (4); 429 chamando o serviço (5); rajada vence dia quando ambos estouram (4); dia em UTC (9); sem teto de 1000 no mapa (3); dono falhando fechado (8); log com stack e scope extra (4); limite antes do `ENABLE_GPT_LIVE` (14); TTL do dia alterado (4, depois de eu ter fixado o TTL em teste).
Sobreviveu na primeira rodada: troca do TTL de 90000 para 3600 (60 passaram). Fechado com o teste "the day counter lives 90000 s". Nenhuma sobrevivente restante nas 14 mutações.
Obs.: a mutação por `contextId` derruba só 1 teste, mas ele cobre as 4 rotas só na assertiva de chave forjada do orchestrator; nas outras rotas o corpo forjado é testado, mas a mutação não foi aplicada nelas.

## Não verificado
- Upstash real: o `EVAL` com TTL 90000 só foi exercitado contra o store em memória e o fake; o script não foi alterado.
- Rajada entre instâncias (é por instância, por contrato) e comportamento real da Vercel.
- Fala do `scope: "day"` no PWA e `tests/MANUAL.md` (do `web`).
- qa e security-review (Opus) ainda não rodaram; área crítica.
- `Retry-After` do dia numa virada de horário de verão: São Paulo não tem hoje; o cálculo usa a hora local do dia.

## Desvios
1. O store recusava `windowSeconds` > 86400 (hardening anterior), mas o contrato manda TTL 90000. Subi o teto do store para 90000 e ajustei o teste que fixava 86401. Sem isso, toda requisição de IA daria 503.
2. (Superado pelo ajuste de ordem abaixo.)
3. `driverId` ou classe inválidos viram 503 sem tocar contador (falha fechada); o contrato só diz que nunca viram chave.
4. Dono com Redis fora: um aviso fixo `[ai-limit] <classe> day counter unavailable`, sem id nem chave.

## Decisões para o dono
- Teto de `windowSeconds` do store em 25 h (desvio 1): aprovado pelo orquestrador; fronteira testada (90000 aceito, 90001 recusado).
- Rajada barrada gastar cota do dia: resolvido pelo orquestrador (ver "Ajuste de ordem").
- Commits: 0183c49, 6901d91, 4993764 e um de docs.

## Ajuste de ordem (decisão do orquestrador, última linha do Histórico do contrato)
- `enforceAiLimit`: a rajada é checada primeiro; se estourou, 429 `scope: "burst"` sem chamar `incrementRateLimit` (nenhum comando do Upstash, nenhuma cota do dia). O dia só conta o que passou pela rajada; `scope: "day"` só aparece em requisição que passou. Malformadas (400/413) continuam contando. Com Redis fora, quem a rajada barra recebe 429, não 503. A chave inválida continua dando 503 antes de qualquer contagem.
- Testes: removido o caso "os dois estouram, day". Novos: loop de 30 requisições gera exatamente 20 incrementos (espião do store) e o contador do dia fica em 20; com o dia já estourado, a rajada vence e o store não é chamado; Redis fora + rajada = 429. Contagens de 400/413 agora esperam 20 (5 em `live`) no dia, não 21. `hardening.test.ts` prova 90000 aceito e 90001 recusado (memória e Upstash fake).
- Mutações (cópia fora do repositório): incrementar sempre o dia (sem o retorno antecipado da rajada) derrubou 22 testes (N1, N2 e N3 são a mesma alteração em três formas; reportadas juntas); remover o limite de stt, 14; falhar aberto para motorista, 4; chave por `contextId`, 1. Nenhuma sobrevivente.
- Lote final: `npm test` 1211 passaram e 4 pulados; typecheck, lint e build sem erros.
- `docs/ARCHITECTURE.md` não descreve a ordem; não mudou.

## Rodada de correções (qa e security-review)
**O que mudou**
1. A2A: `POST /api/agents/[agent]` chama `enforceAiLimit("a2a", dono)` após `guardA2A` e antes do corpo e do agente; classe `a2a` com os tetos do orquestrador (a regex de classe passou a aceitar dígitos). Não criei nem pedi `FINN_A2A_TOKEN`: os testes só o definem no ambiente de teste.
2. Tetos de entrada: `transcript` até 2000 caracteres (após `trim`), com 400. Escolhi 400 porque é o código das outras validações de campo (`text` do tts, `sdp`, `transcript` vazio); 413 fica para tamanho do corpo bruto. Áudio do `transcribe`: 1 MB decodificado (era 10 MB), no mesmo ponto do 413 atual, valendo para JSON e multipart; o tamanho real é conferido mesmo sem `content-length` (a checagem prévia de `content-length` continua em 1,5 x o teto). Justificativa do 1 MB: o PWA envia WAV mono 16 kHz 16 bits (32 KB/s); a fala dura no máx. 12 s (`MAX_UTTERANCE_MS`) e o buffer do "Pronto" manual tem 470 quadros de 32 ms (15 s), cerca de 480 KB; 2x dá cerca de 960 KB, e o mínimo pedido é 1 MB.
3. Falha aberta do dono só com `DriverStoreUnavailableError`; qualquer outro erro dá 503, também para o dono.
4. `Object.hasOwn(AI_LIMITS, cls)`.
5. Aviso por estouro: no máximo 1 por classe e escopo a cada 60 s por instância, comparando com o relógio injetado, sem timers. O aviso do dono com Redis fora usa o mesmo limitador.
6. Testes novos: rajada independente por classe, ordem de eviction (a mais antiga sai; janela renovada vai para o fim), teto contra o literal 1000, 503 do motorista com `DriverStoreUnavailableError` e outro erro, `Retry-After` do dia a milissegundos da meia-noite, classes de protótipo, aviso limitado (100 estouros = 1 linha; após 60 s outra; escopos de uma classe separados).
7. Docs: ARCHITECTURE (A2A, tetos de entrada) e ESTADO_ATUAL (A2A coberto, tetos, `--max-uses 1`, A3 cobrindo as três famílias de rota).

**Comandos e contagens:** `npm test`: 60 arquivos passaram, 1 pulado; 1276 testes passaram, 4 pulados. `npm run typecheck`, `npm run lint` (0 avisos após remover um import sem uso) e `npm run build`: sem erros.

**Mutações** (cópia fora do repositório; 16 mais 1 repetida): A2A sem limite (5 testes caíram), limite do A2A antes da autenticação (4), A2A com a classe do orquestrador (3), teto do transcript removido (2) e com erro de uma unidade (2), teto de áudio de volta a 10 MB (4), dono abre com qualquer erro (4), `in` no lugar de `hasOwn` (1), aviso sem limitação (5), limite de 60 s com `<=` (4), `floor` no `Retry-After` (1), eviction do mais novo (1), janela renovada sem ir ao fim (1), teto 1001 (1), rajada única para todas as classes (3). Sobreviveu uma: chave do aviso sem o escopo (a limitação por classe sem escopo); fechei com teste (dois escopos da mesma classe no mesmo minuto) e a mutação passou a morrer (1). Nenhuma sobrevivente final.

**Não verificado:** Upstash real; limite real de corpo na Vercel; áudio real do iPhone (o teto vem do cálculo do formato e dos limites no código do PWA, não de captura real); A3 (firewall) e alerta de cota; qa e security-review não foram repetidos nesta rodada.

**Desvios:** nenhum novo. O teto de áudio é 1 MB (mínimo do brief), acima do cálculo de 2x (cerca de 960 KB). Itens aceitos pelo orquestrador (eviction, Redis lento, horário de verão, atraso de fala do 429) ficam como estão.

## Rodada final (checagem pontual de segurança: N1, N2, N3)
**O que mudou**
- N1: `src/lib/wav-guard.ts` (novo). `transcribe` valida o cabeçalho RIFF/WAVE: `fmt ` PCM (formato 1), 1 a 2 canais, 8000 a 48000 Hz, 8/16/24/32 bits, chunk `data` presente, percorrendo chunks com alinhamento e no máximo 16. Recusa mais de 20 s. Códigos: **415** quando não é RIFF/WAVE ou não é PCM inteiro (opus, webm, ogg, mp3, float, ADPCM); **400** para WAV truncado, malformado, parâmetros absurdos (zero, fora da faixa, sem divisão por zero), `data` maior que o arquivo ou áudio acima de 20 s; 413 continua para mais de 1 MB. Justificativa: 415 descreve "tipo de mídia que não aceito", 400 descreve "é do tipo certo mas está inválido ou longo". O encaminhamento ao provedor é sempre `audio.wav` / `audio/wav`, em JSON e multipart, sem ler `mimeType`, nome ou tipo do cliente.
- Formato do PWA conferido em `encodeWav16kMono` (`stt-tts-session.ts`): cabeçalho de 44 bytes, PCM mono 16 kHz 16 bits, enviado em JSON com `mimeType: "audio/wav"`. Um enunciado de 12 s e o buffer manual de 470 quadros (15,04 s) passam; os testes usam o próprio codificador.
- N2: o `transcript` do A2A (`src/lib/a2a-server.ts`) tem o teto de 2000 caracteres, depois do `trim` e somando as partes de texto; erro JSON-RPC `-32602` (parâmetros inválidos) com o `id` da requisição, igual ao erro de "texto ausente" ali.
- N3: `enforceAiLimit(..., { ownerFailsOpen: false })`; o A2A usa; as três rotas do PWA mantêm a falha aberta do dono.
- Testes ajustados: os que mandavam bytes falsos como áudio agora mandam WAV (`tests/helpers/wav.ts`); os testes de teto de 1 MB usam WAV de 48 kHz para o arquivo inteiro de 1 MB caber em 20 s.

**Mutações** (cópia fora do repositório; 12, todas mortas): aceitar não-WAV (2 testes caíram), duração só pelo campo do cabeçalho (2), aceitar `data` maior que o arquivo (2), aceitar formato não PCM (2), sem checagem de taxa, canais e bits (2), limite de 21 s (4), checagem de WAV removida da rota (12), repasse de `mimeType` e nome do cliente (2, mutada só no caminho JSON), A2A falhando aberto removendo a opção na rota (1) e ignorando a opção no limitador (1), teto do transcript do A2A removido (1), rotas do PWA perdendo a falha aberta (5).

**Não verificado:** como Groq e OpenAI tratam um WAV real de 20 s (nenhuma chamada real foi feita); PCM de 24 e 32 bits nos provedores (aceito pelo guard, não testado ponta a ponta); áudio real de iPhone; Upstash real.

**Desvios:** a duração é calculada pelos bytes reais depois do início de `data` (o maior entre declarado e real, já que declarado maior que o arquivo é recusado), e não pelo menor dos dois como no brief. É mais estrito: um `data` declarado pequeno sobre um arquivo longo é medido pelo tamanho real, porque um decodificador pode ler tudo. Bytes depois do `data` (por exemplo um chunk `LIST` ao final) entram na conta; o PWA não envia nenhum.
