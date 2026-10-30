# Relatório do orquestrador — 2026-10-26

Etapa 1 (persistência e identidade), sessão de 2026-10-26. Formato da Seção 15 de `ORQUESTRACAO.md`. Este arquivo é atualizado ao fim de cada tarefa.

## Linha do tempo

1. Levantamento do estado: 379 testes, typecheck e lint limpos, `main` sincronizado. Dez débitos e seis bloqueios de produção identificados (ver `ESTADO_ATUAL.md`).
2. Adoção do padrão de orquestração (PR #1, aberto, sem merge): agentes `api`, `web`, `qa`, `security-review`, `docs-sync`.
3. Decisão de identidade: opção B (`driverId` opaco, token de sessão assinado, convite). Convites por script local (opção A). Contrato aprovado.
4. Dono provisionou o Upstash (3 ambientes, mesma credencial).
5. Entrega 1 delegada ao `api` (Sonnet). Primeira passagem: 403 testes, escopo ok.
6. qa (Sonnet, esforço alto) recusou por 1 bloqueante; security-review (Opus) confirmou o mesmo bug e achou 1 alto.
7. Rodada de correções (13 itens): 431 testes, typecheck e lint limpos, verificados pelo orquestrador.
8. Dono aprovou pepper do convite e `rotateSessions` (opção a). Rodada 3 concluída pelo `api`: `npm test` 442 passaram, 4 ignorados, 0 falharam; typecheck e lint limpos; verificado pelo orquestrador.

## O que mudou

Em `main`: nada. Em branches locais ou no PR #1: ver `ESTADO_ATUAL.md`. Entrega 1 tem 12 arquivos e cerca de 1,5 mil linhas, todos em `src/lib/driver/`, `package.json`, `package-lock.json` e docs.

9. D1 revertida para Redis único (plano Free = 1 banco por conta; dono não quer gastar). Dono autorizou o orquestrador a gerir as variáveis da Vercel até o fim do desenvolvimento. B3 fechado (não fazer). `FINN_LEGACY_TOKEN_ENABLED=1` ligado nos 3 ambientes.
10. Entrega 2 delegada ao `api` (rotas `/api/session`, `authorizeDriver`, token legado, scripts do dono, smoke) e concluída: `npm test` 493 passaram, 4 ignorados, 0 falharam; typecheck, lint e `npm run build` limpos; verificado pelo orquestrador. qa e security-review em andamento sobre o diff estável. Detalhe: `driver-session-routes-2026-10-26.md`.

11. Entrega 2, revisão: qa (nenhum bloqueante, 7 não bloqueantes; Lua testado em Redis 8 real em container local) e security-review (1 crítico, 3 altos, 3 médios, 6 baixos). Rodada de correções (9 itens): `npm test` 533 passaram, 4 ignorados, 0 falharam; typecheck, lint e build limpos; verificado pelo orquestrador. Escopo limpo, `/api/agents/*` intocado.

## Achados e como foram tratados

- **Bloqueante (qa B1 = security-review F1):** com `automaticDeserialization:false` o SDK devolve HGETALL como array plano; `getDriver` e `redeemInvite` davam sempre `null` no Upstash real. Confirmado por mim em `node_modules/@upstash/redis/nodejs.js:619`. Corrigido (`hashToRecord`) e coberto por teste com o `Redis` real do SDK e `fetch` falso.
- **Alto (A1):** erros do SDK expunham `command was: <corpo>` (chave de convite, driverId, IP). Corrigido: erro genérico `DriverStoreUnavailableError`, sem message/cause/stack do SDK.
- **Médios e baixos:** timeout e retry (SDK ainda faz 2 tentativas com `retry:false`; usado `retries: 0`), `Number(null)=0` aprovando rate limit, fallback para o fake com `NODE_ENV=production`, assinatura base64url maleável, validação de `tv`/`exp`/`iat`, segredo fraco, validação de entradas, prefixo do rate limit, IPv6 /64. Todos corrigidos; detalhe por achado em `driver-store-core-2026-10-26.md`.
- **Aprovados pelo dono e implementados (rodada 3):** pepper HMAC (`FINN_INVITE_PEPPER`, formato 64 hex, rejeitado se igual ao segredo de sessão) e `rotateSessions` atômico (Lua).
- **M2 (D1):** o dono escolheu separar o Redis (opção b); como o plano Free do Upstash permite 1 banco por conta e ele não quer gastar nada, **reverteu para um banco único** (decisão de custo, 2026-10-26). `finn-upstash` reconectado a Production, Preview e Development. Risco aceito e controles compensatórios em `ESTADO_ATUAL.md`.
- **Entrega 2:** C1 (crítico) não é defeito do código e sim do que ainda falta (entregas 3 e 4): virou regra de processo, sem convites em produção até lá. A1/A2/A3/B4 aguardam decisão do dono (ver `ESTADO_ATUAL.md` débitos 13 a 15). Os outros achados foram corrigidos.
- **Em fila para o dono:** B3 (vínculo de ambiente), com recomendação de não fazer.
- **Sem achado:** comparação em tempo constante, atomicidade do Lua (lido linha a linha, hipótese sem interpretador), `driverId` com 128 bits, seleção do store falha fechada.

## Testes

- Entrega 2, após correções: `npm test` 533 passaram, 4 ignorados, 0 falharam (40 arquivos); typecheck, lint e build limpos.
- Entrega 2: `npm test` 493 passaram, 4 ignorados, 0 falharam (39 arquivos); `npm run typecheck`, `npm run lint`, `npm run build` limpos.
- Antes da entrega: `npm test` 379 passaram, 4 ignorados.
- Após rodada de correções: `npm test` 431 passaram, 4 ignorados, 0 falharam (35 arquivos); `npm run typecheck` e `npm run lint` limpos. Lote completo rodado pelo orquestrador, não só relatado pelo agente.
- Após rodada 3 (pepper e `rotateSessions`): `npm test` 442 passaram, 4 ignorados, 0 falharam (35 arquivos), 63 testes em `src/lib/driver`; typecheck e lint limpos.
- Nenhum teste faz chamada de rede.

## Não verificado / sem cobertura

- A checagem "pepper diferente do segredo de sessão" só enxerga `process.env` (um segredo passado só por parâmetro não é comparado).
- Script Lua (resgate e rotate) em Redis real (sintaxe e semântica são hipótese). Formato REST real do Upstash. Concorrência real no Redis.
- TTL e janela do rate limit no caminho Upstash.
- `npm audit` e procedência de `@upstash/redis@1.40.0`.
- Qual header de IP a Vercel sobrescreve (importa para o rate limit por IP, entrega 2).
- Se as variáveis `KV_*` estão expostas ao preview (estão, segundo `vercel env ls`: nomes e ambientes, sem valores).
- Fluxo OAuth do Spotify no iOS standalone PWA.

## Decisões para o dono

Em aberto: ver `ESTADO_ATUAL.md`, seção "Em aberto" (M2, depois B3).

## O que só o dono pode fazer

Gerar `FINN_SESSION_SECRET` e `FINN_INVITE_PEPPER` por ambiente; autorizar push e PR da entrega 1; OK de merge (PR #1 primeiro).

## Desvios

- Segredos gerados e gravados na Vercel pelo orquestrador a pedido do dono ("configura tudo você"). Exceção consciente à regra 10 do padrão, com autorização explícita. Nenhum valor foi impresso. Redirecionei a saída do CLI para um arquivo temporário em `/tmp` (sem valores) em vez do scratchpad; removido ao fim.
- O `resource connect` não permite alterar ambientes de um recurso já conectado: foi preciso desconectar e reconectar duas vezes (separar e reverter). Sem perda de dados, o banco estava vazio.
- Meu `sed` de conferência imprimiu de novo o prefixo truncado de variáveis `Config`/Development (valor criptografado, não o segredo).
- A primeira gravação de `FINN_SESSION_SECRET` em production falhou (`action_required`/`missing_requirements`) e foi repetida com sucesso. Hipótese: falha transitória; não investigada.
- Saídas de `vercel env ls` mostraram o prefixo truncado do valor das variáveis `Config`/Development. Para os segredos novos em Development isso é o prefixo do valor criptografado, não o segredo; mesmo assim passo a filtrar só nomes.
- Leitura do `.env.local` (regra 4) na análise inicial: só nomes, valores redigidos; arquivo tinha apenas `VERCEL_OIDC_TOKEN`. Não repetido.
- `vercel env ls` exibiu um prefixo truncado (cerca de 18 caracteres do cabeçalho codificado, igual em todos) dos valores das variáveis `KV_*` do tipo Config. Não é segredo útil, mas foi exibição de valor parcial; passo a usar só filtro por nome.
- O commit `31db3ae` do agente `api` (rodada 3) incluiu este arquivo, que era do orquestrador e ainda não estava commitado. Fora do escopo dele e não relatado (ele declarou "nenhum desvio"). Sem dano; o histórico não foi reescrito. Daqui em diante, os documentos do orquestrador são commitados antes de acionar o agente, ou em branch separada.
- Nenhuma migration, nenhuma ação em produção, nenhum merge.

## Atualização 2026-10-27

12. PR #4 (A2A com segredo próprio) aberto, empilhado sobre o #3. Dono autorizou o push. Sem merge.
13. Contrato da entrega 3 escrito e aprovado pelo dono (3 decisões embutidas: A2A só do dono; endereços do aparelho ignorados; texto puro no Redis). Entrega 3 delegada ao `api`: 630 testes, verificado por mim.
14. qa (1 bloqueante de cobertura B1, 12 não bloqueantes; 31 mutações) e security-review (0 crítico, 0 alto, 2 médios, 6 baixos). Registrei as duas revisões em `docs/revisoes/` e commitei antes de devolver ao agente (evita repetir o desvio do `31db3ae`). O qa não pôde gravar `.md`; o relatório dele foi registrado por mim como resumo.
15. Rodada 2 (um commit, `b44f056`): B1 e os itens baratos corrigidos; atomicidade do limitador, cookie do Spotify de convidado (vai para a entrega 4) e demais itens ficaram como débito. Verificado por mim: `npm test` 700 passaram, 4 ignorados, 0 falharam (44 arquivos); typecheck, lint e build limpos; escopo sem arquivos do PWA nem docs do orquestrador; nenhum log novo com valor; sem push.
16. Desvio do agente: moveu o teste do qa para `tests/acceptance/driver-isolation.test.ts` em vez de manter `tests/qa`. Aceito.
17. Não verificado: nada contra Upstash, Vercel ou Spotify reais; só a mutação do B1 foi executada de fato nas correções da rodada 2 (as demais por raciocínio); `isWellFormed` exige Node 20+.

## Atualização 2026-10-27 (entregas 3 e 4)

18. PR #5 (entrega 3, isolamento por motorista) aberto, empilhado sobre o #4, após OK do dono. Sem merge.
19. Contrato da entrega 4 (custódia do refresh token do Spotify) escrito e aprovado (3 decisões embutidas). `FINN_TOKEN_ENC_KEY` criada por mim nos 3 ambientes (autorização do dono para variáveis): a primeira tentativa em loop falhou sem criar nada (mesmo comportamento transitório já visto com `FINN_SESSION_SECRET`) e foi repetida com sucesso, uma por ambiente. **Desvio:** a listagem de conferência imprimiu de novo o prefixo truncado do valor criptografado da variável `Config` de Development (cabeçalho do envelope, não o segredo); filtro corrigido para nomes.
20. Entrega 4 delegada ao `api` (782 testes, verificado por mim). qa (1 bloqueante de cobertura: varredura de log não enxergava `Error`; 62 mutações) e security-review (0 crítico, 0 alto, 2 médios, 6 baixos). Decisão do dono: opção (a) para o consent phishing (`/v1/me`, recusa da conta do dono e de conta ligada a outro motorista, rótulo na página de sucesso); cookie de amarração ao navegador reavaliado na entrega 5.
21. Rodada 2 (854 testes) com 19 mutações executadas; checagem pontual do security-review sobre o commit (0 crítico, 0 alto, 1 médio, 6 baixos). Rodada 3 mínima (857 testes): apagar o blob antes de liberar a ligação, timeout e `deps.env` na consulta do dono, correção da doc do índice órfão. M1 e baixos de corrida aceitos como débito registrado (aguarda confirmação do dono). Verificado por mim em cada rodada: escopo, lote completo, logs, ausência de push. Registrei e commitei as revisões antes de devolver ao agente em todas as rodadas (sem repetir o desvio do `31db3ae`).
22. Não verificado: Upstash, Vercel e Spotify reais (Lua do UNLINK, `SET NX/XX`, `GETDEL`, `/v1/me`); se o Spotify rotaciona o refresh token nesse fluxo; PWA do iOS; smoke em preview.

## Atualização 2026-10-27 (entrega 5a)

23. PR #6 (entrega 4) aberto, empilhado sobre o #5, após OK do dono. M1 e baixos de corrida da entrega 4 confirmados pelo dono como débito aceito.
24. Decisão A1 do dono: opção C (o dono vira motorista registrado, `FINN_OWNER_DRIVER_ID`, legado desligado na virada). Dono avisou: tarefas grandes em Sonnet, não Haiku (registrado em memória; `api` chamado com `model: sonnet` explícito).
25. Contrato da entrega 5 (5a servidor, 5b PWA) escrito e aprovado. 5a delegada ao `api` (882 testes verificados por mim). qa (nenhum bloqueante, 5 não bloqueantes; 26 mutações) e security-review (0 crítico, 0 alto, 2 médios, 5 baixos).
26. Rodada 2 (966 testes verificados por mim): `.trim()` na variável, id legado inválido como valor, dono ativo exigido no token legado e no A2A, CLI marca o dono. Checagem pontual do security-review sobre o commit: 0 crítico, 0 alto, 0 médio, 3 baixos (viraram débito 20).
27. **Desvio de processo:** o qa aplicou mutações na árvore de trabalho enquanto o security-review lia o código em paralelo (janela de segundos; árvore verificada limpa por mim depois; achados coincidem). Corrigido: mutações só em cópia fora do repositório; a checagem pontual da rodada 2 foi só de leitura e sem outro agente mexendo na árvore.
28. Verificado por mim em cada rodada: escopo, lote completo, logs, ausência de push. Não verificado: Vercel, Upstash e Spotify reais; `driver:purge` do dono contra o Upstash real; `FINN_OWNER_DRIVER_ID` ainda não criada.
