# Relatório: limites por motorista nas rotas de IA, servidor (M3)

Agente: api (Sonnet). Branch `feat/ai-rate-limits`. Contrato: `docs/contratos/limites-por-motorista.md`. Sem push, sem merge.

## O que mudou
- `src/lib/ai-limits.ts` (novo): `AI_LIMITS` (stt/orchestrator/tts 20 por min e 600 por dia; live 5 e 30), `enforceAiLimit(classe, driverId)`, rajada em memória (janela 60 s, máx. 1000 entradas, varredura das vencidas ao encher, sem timers), dia no Redis via `incrementRateLimit` com chave `ratelimit:ai:<classe>:<AAAAMMDD>:<driverId>` e TTL 90000, dia em `America/Sao_Paulo` por `Intl`. Ganchos de teste: `resetAiLimitsForTests(relógio)`, `burstEntryCountForTests`.
- 4 rotas chamam o helper logo após `authorizeDriver` (em `session`, após `ENABLE_GPT_LIVE`), antes de ler corpo.
- `src/lib/driver/store.ts`: `MAX_RATE_WINDOW_SECONDS` 86400 para 90000 (ver desvios); `hardening.test.ts` ajustado (limite testado 90001).
- Testes: `tests/acceptance/ai-limits.test.ts` (64 testes, 4 rotas); `tests/helpers/harness.ts` zera a rajada por teste; `src/app/api/orchestrator/route.test.ts` ganhou `isOwner` no mock de auth.
- Docs: ARCHITECTURE (tabela de rotas) e ESTADO_ATUAL (débito 16 resolvido, tetos e onde mudar).

## Comandos e contagens
`npm test`: 59 arquivos passaram, 1 pulado; 1206 testes passaram, 4 pulados. `npm run typecheck`, `npm run lint`, `npm run build`: sem erros. Rodados uma vez, no fim.

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
2. Requisição barrada por rajada também incrementa o contador do dia (um comando de Redis por requisição, "toda requisição conta"); é o que permite `scope: "day"` quando ambos estouram.
3. `driverId` ou classe inválidos viram 503 sem tocar contador (falha fechada); o contrato só diz que nunca viram chave.
4. Dono com Redis fora: um aviso fixo `[ai-limit] <classe> day counter unavailable`, sem id nem chave.

## Decisões para o dono
- Aceitar subir o teto de `windowSeconds` do store para 25 h (desvio 1).
- Rajadas barradas gastam cota do dia: ok, ou preferir não contar? (um loop de cliente com bug queima o dia mesmo bloqueado.)
- Commits: 0183c49, 6901d91, 4993764 e um de docs.
