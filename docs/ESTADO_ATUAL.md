# Finn — estado atual

Atualizado em 2026-10-27. Processo: [`ORQUESTRACAO.md`](./ORQUESTRACAO.md). Arquitetura: [`ARCHITECTURE.md`](./ARCHITECTURE.md). Plano: [`PERSONALIZATION_AND_LEARNING.md`](./PERSONALIZATION_AND_LEARNING.md).

## Estado

- MVP funcionando no carro (iPhone PWA, v0.5.8). Wake word Porcupine, STT Groq Whisper, Neuralake + fallback Groq, agentes Spotify e Waze.
- `main` limpo e sincronizado. 379 testes passam (4 pulados live), typecheck e lint limpos (2026-10-26).
- Sem CI. Lote completo roda localmente, uma vez por branch.
- Persistência: nenhuma durável em `main`. Endereços ditados vivem na memória da função (somem no cold start).
- Upstash for Redis (`finn-upstash`, plano Free) provisionado pelo dono em 2026-10-26, ligado a Production, Preview e Development: **um banco só, mesma credencial**. Tentativa de separar (D1 opção b) foi revertida no mesmo dia, ver Decisões provisórias. Variáveis: `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `KV_REST_API_READ_ONLY_TOKEN`, `KV_URL`, `REDIS_URL`.
- `FINN_SESSION_SECRET` e `FINN_INVITE_PEPPER` configurados na Vercel pelo orquestrador (autorização do dono, 2026-10-26): 6 valores distintos (um par por ambiente), gerados com `openssl rand -hex 32` e enviados por pipe sem exibição. Production e Preview são `Sensitive`; Development não pode ser (limite da Vercel) e fica legível por `vercel env pull` para quem tem acesso ao projeto.
- Etapa 1, entrega 1 (núcleo `src/lib/driver/`): implementada e corrigida após qa e security-review, em `feat/driver-store-core` (local, sem PR ainda). Relatórios: [`relatorios/driver-store-core-2026-10-26.md`](./relatorios/driver-store-core-2026-10-26.md), [`revisoes/driver-store-core-security-review.md`](./revisoes/driver-store-core-security-review.md), [`relatorios/orquestrador-2026-10-26.md`](./relatorios/orquestrador-2026-10-26.md). Rodada 3 (pepper do convite e `rotateSessions`) concluída: 442 testes passam, typecheck e lint limpos. Falta: push e PR (aguarda OK do dono), depois entrega 2.
- Entrega 2 (rotas de sessão, `authorizeDriver`, scripts do dono, smoke) implementada em `feat/driver-session-routes` (local): 533 testes, build ok; qa e security-review concluídos e correções aplicadas; falta push e PR (aguarda OK), mais as decisões A2, A1, B4 e A3 do dono. Relatório: [`relatorios/driver-session-routes-2026-10-26.md`](./relatorios/driver-session-routes-2026-10-26.md).
- PRs (todos abertos, sem merge, empilhados): #1 adoção do padrão; #2 contrato e núcleo (entrega 1); #3 rotas de sessão e scripts (entrega 2); #4 A2A com segredo próprio; #5 isolamento por motorista (entrega 3); #6 custódia do token do Spotify (entrega 4). Ordem de merge: #1 a #6.
- Entrega 3 (isolamento por motorista, contrato aprovado em 2026-10-27: [`contratos/isolamento-por-motorista.md`](./contratos/isolamento-por-motorista.md)) implementada em `feat/driver-isolation` (local, sem push): 700 testes passam, 4 ignorados, typecheck, lint e build limpos (verificado pelo orquestrador). qa e security-review concluídos (0 crítico, 0 alto) e correções da rodada 2 aplicadas. C1 fechado no código; M1 do A2A atendido (6 pontos). Relatório: [`relatorios/driver-isolation-2026-10-27.md`](./relatorios/driver-isolation-2026-10-27.md); revisões em `revisoes/driver-isolation-*.md`. PR #5 aberto, sem merge.
- Entrega 4 (custódia do refresh token do Spotify; contrato aprovado em 2026-10-27: [`contratos/custodia-token-spotify.md`](./contratos/custodia-token-spotify.md)) implementada em `feat/spotify-token-custody` (local, sem push): 857 testes passam, 4 ignorados, typecheck, lint e build limpos (verificado pelo orquestrador). Token cifrado (AES-256-GCM, AAD com ambiente e `driverId`) no Redis; OAuth iniciado por `POST /api/spotify/connect` autenticado, `state` de uso único no Redis; o servidor ignora qualquer token vindo do cliente; `/v1/me` recusa a conta do dono e conta já ligada a outro motorista (opção (a) do dono para o consent phishing). qa e security-review concluídos (0 crítico, 0 alto) mais checagem pontual da rodada 2; 3 rodadas de correção. Relatório: [`relatorios/spotify-token-custody-2026-10-27.md`](./relatorios/spotify-token-custody-2026-10-27.md); revisões em `revisoes/spotify-custody-*.md`. PR #6 aberto, sem merge.
- Entrega 5 (dono registrado + PWA com convite; contrato aprovado em 2026-10-27, decisão A1 opção C: [`contratos/pwa-convite-e-dono.md`](./contratos/pwa-convite-e-dono.md)). **5a (servidor)** implementada em `feat/owner-driver-id` (local, sem push): 966 testes passam, 4 ignorados, typecheck, lint e build limpos (verificado pelo orquestrador). Dono = `FINN_OWNER_DRIVER_ID` (ou, só com a flag legada ligada, o id legado); token legado e A2A exigem o dono ativo quando ele tem registro; servidor ignora `driverContext`; CLI marca o dono. qa e security-review (0 crítico, 0 alto) e checagem pontual da rodada 2 (0 crítico, 0 alto, 0 médio, 3 baixos). Relatório: [`relatorios/owner-driver-id-2026-10-27.md`](./relatorios/owner-driver-id-2026-10-27.md); procedimento do dono: [`procedimentos/dono-registrado.md`](./procedimentos/dono-registrado.md). **5b (PWA)** ainda não iniciada. `FINN_OWNER_DRIVER_ID` ainda NÃO existe na Vercel (virada: ver roteiro no contrato).
- `FINN_TOKEN_ENC_KEY` criada na Vercel pelo orquestrador (2026-10-27, autorização do dono): 3 valores distintos (Production e Preview `Secret`, Development `Config`), `openssl rand -hex 32`, enviados por pipe. Trocar a chave obriga todos a reconectar o Spotify.
- **Convites em produção continuam bloqueados até a entrega 5** (PWA com tela de convite e botão "Conectar Spotify"), A1 (token legado), A3 (firewall e alerta de cota do Upstash, agora também o callback do Spotify) e M3. A custódia do token (entrega 4) está pronta.

## Decisões fechadas

- 2026-10-22: voz STT+TTS padrão; GPT-Live-1 bloqueado por custo (`ENABLE_GPT_LIVE=1`).
- 2026-10-22: fast-path de 1 round-trip (`FINN_FAST_SPEECH=1`).
- 2026-10-22: multi-user stateless via `driverContext` (a ser substituído pela etapa 1).
- 2026-10-26: ordem de evolução: (1) Redis + `DriverProfile` + identidade, (2) memória curta da viagem, (3) lugares dinâmicos e aliases, depois rate limit e observabilidade antes de abrir o beta, (4) Modo Rotina. Camada 4 do plano espera.
- 2026-10-26: o beta será aberto a outras pessoas, mas só com acesso controlado pelo dono.

- 2026-10-26: o dono autorizou o orquestrador a **gerenciar as variáveis de ambiente da Vercel até o fim do desenvolvimento** (criar, alterar, remover; nunca imprimir valores). Continua valendo: nada em produção além disso sem OK, sem merge, sem push na `main`.
- 2026-10-26: B3 fechado (não fazer). Entrega 2 liberada.
- 2026-10-26: após o security-review da entrega 1, o dono aprovou duas adições ao contrato: pepper HMAC (`FINN_INVITE_PEPPER`) no hash do convite e `rotateSessions` (incrementa `tokenVersion` sem banir o motorista). Motivo: baratas agora, caras depois de haver convites emitidos.
- 2026-10-26: decisões técnicas do agente aceitas (provisórias, ajustáveis por parâmetro): rate limit do resgate 10 por 600 s por IP; IP ausente ou inválido cai num balde próprio de 3 por 600 s; teto de espera do Redis 2 s sem retry (o EVAL de resgate nunca é retentado); tempo em ms em `expiresAt`, em s em `iat`/`exp`.

- **REGRA DE PROCESSO (security-review da entrega 2, C1 crítico, 2026-10-26): NENHUM convite pode ser emitido em produção antes das entregas 3 e 4.** Hoje o orquestrador autentica o convidado mas não usa o `driverId`: Spotify cai no `SPOTIFY_REFRESH_TOKEN` do dono e o Waze lê e grava o livro de endereços global (casa do dono). Quem resgatar convite controlaria o Spotify do dono. A entrega 3 deve começar pela trava (sem `driverId` do dono, desligar o Spotify do servidor e o livro global). O smoke `smoke:session` só roda a etapa do orquestrador com opt-in explícito.
- 2026-10-26: flag `FINN_LEGACY_TOKEN_ENABLED` removida de Preview e Development (segurança, superfície do token legado); fica só em Production até o PWA novo (entrega 5). O token legado não expira e o `driverId` dele não tem registro no store.

- 2026-10-27 (A2, security-review da entrega 2): o A2A (`/api/agents/*`) passa a exigir segredo próprio `FINN_A2A_TOKEN`; sem a variável o endpoint fica desligado (falha fechada) e o `FINN_API_TOKEN` deixa de abri-lo. Recomendação do orquestrador aceita pelo dono. Variável NÃO criada ainda (ninguém usa o A2A); criar quando houver cliente. Reabre se algum cliente externo precisar do A2A.

- **REGRA DE PROCESSO (security-review do A2A, M1, 2026-10-27): NÃO criar `FINN_A2A_TOKEN` na Vercel antes da entrega 3 resolver:** de quem são os recursos que o A2A usa (dono explícito, ou `driverId` provado no servidor), livro de endereços não global, limite de taxa em Redis ou Firewall (não em memória), rotação e revogação do segredo, validação ou assinatura da `continuation` (vem do cliente sem validação) e revisão do artifact `result`. Enquanto a variável não existir, o A2A fica desligado (503).

## Decisões provisórias

- **Redis único (D1, 2026-10-26):** o dono escolheu primeiro separar o banco de produção (opção b), mas o plano Free do Upstash permite **1 banco por conta** e um segundo exigiria Pay as You Go. O dono não quer gastar nada por enquanto, então ficou **um banco para os 3 ambientes**, separados só pelo prefixo `finn:<env>:`.
  - Controles compensatórios já em vigor: `FINN_SESSION_SECRET` e `FINN_INVITE_PEPPER` distintos por ambiente (um token ou convite de preview não valida em produção); prefixo de chave por ambiente; `NODE_ENV=production` nunca usa o fake.
  - Risco aceito: um bug ou vazamento da credencial em preview alcança as chaves de produção (security-review M2). Não usar convites reais em preview.
  - Reabre se: houver orçamento para um segundo banco (Pay as You Go com teto de gasto via `vercel integration resource create-threshold`), ou antes de abrir o beta a usuários reais, o que vier primeiro.

- **Identidade (opção B, 2026-10-26):** `driverId` opaco gerado pelo servidor; token de sessão assinado, emitido em troca de código de convite criado e revogável pelo dono. O Spotify ID é só atributo ligado ao perfil (índice `spotify:<id> → driverId`). Substitui o `FINN_API_TOKEN` compartilhado.
  - Convites criados e revogados por script local rodado pelo dono (sem rota de admin). Contrato aprovado em 2026-10-26: [`contratos/identidade-e-perfil.md`](./contratos/identidade-e-perfil.md).
  - Reabre se: for preciso convidar pelo celular com frequência (rota de admin), for preciso login sem convite (migrar para OAuth Spotify, opção C, só troca a forma de emitir o token), ou o OAuth quebrar no iOS standalone PWA.

## Casos cinzentos aceitos

- OAuth do Spotify dentro de PWA standalone no iOS: comportamento do redirect não verificado. Desenho esperado: abrir fora do PWA e voltar com o token já emitido pelo servidor.
- Modo desenvolvimento do Spotify limita a 25 usuários cadastrados à mão; acima disso exige extensão de cota.

## Débitos

1. ~~Perfis misturados (`LayeredAddressBook` gravava no livro global)~~ resolvido na entrega 3 (`feat/driver-isolation`).
2. Refresh token do Spotify trafega do aparelho no `driverContext`. Etapa 1, entrega 3.
3. Token único compartilhado `FINN_API_TOKEN`. Etapa 1 (identidade).
4. Sem rate limit por motorista nem métricas de latência/fallback. Antes do beta.
5. Dependência da Neuralake (429 frequente, mascarada pelo fallback Groq). Acompanhar taxa de fallback.
6. `README.md` é o template do Create Next App. Branches `feat/*` já mergeadas podem ser apagadas.
7. TODO `neuralake-memory`: a Neuralake não documenta memória por agente.
8. **Lua nunca rodou em Redis real** e o formato REST dos testes veio do código do SDK `@upstash/redis@1.40.0`, não de uma resposta real. Verificar em preview, assim que houver rota para exercitar o fluxo (entrega 2).
9. `@upstash/redis` fixado em 1.40.0 sem `npm audit` nem checagem de procedência. Fazer antes do beta.
10. Rotas devem tratar `DriverStoreUnavailableError` como negação com erro falável e sem logar o erro (entrega 2).
11. Limite global de resgate de convite não existe (só por IP); tokens de 90 dias sem vínculo de ambiente (B3, em fila).
13. ~~`/api/agents/*` aceita `FINN_API_TOKEN`~~ resolvido pela decisão A2 de 2026-10-27 (branch `feat/a2a-own-token`): implementado; qa e security-review concluídos; correções aplicadas (558 testes); aguardando push e PR #4 (autorização do dono).
14. Todo POST em `/api/session` gasta ao menos 1 comando Redis mesmo após rate limit e não há limite global: risco de esgotar a cota do plano Free sem autenticação (A3). Falta regra de rate limit no firewall da Vercel e alerta de uso no Upstash (ação do dono).
15. Resgate de convite não é idempotente com resposta perdida (qa N4, security B4): retry cria motorista órfão ou 401. Decisão de produto pendente.
17. `extractBearer` rejeita o esquema `bearer` em minúsculo (RFC 7235 diz que não diferencia maiúsculas); comportamento anterior, afeta orchestrator e A2A. Baixa prioridade, decidir antes de haver clientes externos.
16. Sem limite por motorista nas rotas que chamam IA (M3). `console.warn(..., err)` de `src/lib/spotify/auth.ts` resolvido na entrega 4.
18. Débitos da entrega 3 (qa/security-review, aceitos): limitador do A2A não atômico (rajada passa; segredo certo também leva 429 com IP estourado); `Retry-After` fixo em 600; balde `noip` compartilhado fora da Vercel; Redis lento pode somar ~6 s contra o orçamento de 8 s; `revokeDriver` não apaga `driver-addr:*` (falta purga); cliente A2A externo não continua o "waze pergunta o endereço" (artifact sem `continuation`); regra de ambiente relaxado em `src/lib/driver/index.ts` mais frouxa que a de produção; `memoryScope: finn-<agente>` global (vazamento se o TODO `neuralake-memory` for ligado); objetos de erro inteiros em logs pré-existentes (`orchestrate.ts`, `agent-runtime.ts`, `neuralake/client.ts`); ramos `!VITEST` de `runToolLoop` sem teste; `isWellFormed` exige Node 20+ (conferir o runtime).
19. Débitos da entrega 4 (aceitos pelo orquestrador; decisão do dono pendente de confirmação sobre M1): reconexão perde para a rotação do refresh token (security-review round 2 M1, hipótese de o Spotify rotacionar), revoke durante o callback (B1), `DELETE` em corrida com o callback (B3), ligação de conta não atômica e índice órfão sem comando de limpeza (B2), redirect URI com fallback fora de `VERCEL_ENV=production` (B6), cache de access token em outras instâncias por até ~59 min após desconectar/revogar, callback do Spotify sem rate limit (A3), amarração do callback ao navegador (cookie) a reavaliar na entrega 5 depois de testar o iOS, `DriverContext.spotifyRefreshToken` `@deprecated` (remover na entrega 5 junto de `src/lib/voice/orchestrator-client.ts:65`), resíduos do fluxo antigo (cookie `finn_spotify_rt` de 1 ano nunca expirado pelo servidor; `?spotify_refresh_token=` e `localStorage` no PWA até a entrega 5), `SPOTIFY_REFRESH_TOKEN` do dono possivelmente exposto no fluxo antigo (recomendado rotacionar: ação do dono), Lua do UNLINK, `SET NX/XX` e `GETDEL` nunca rodaram em Upstash real.
20. Débitos da 5a (aceitos, de limpeza): A2A com store fora na consulta do dono responde 503 "disabled" em vez de "indisponível" e gasta o log único com o motivo errado; `driver:revoke|purge|rotate` não avisam que o alvo é o dono quando `FINN_OWNER_DRIVER_ID` falta no ambiente do script (e variável exportada no shell vence a do `--env-file`); docstrings de `auth.ts` desatualizados e o id legado escrito à mão no CLI (importar a constante); encanamento de `env` em `refreshFor`; janela de refresh em voo na troca de dono; `EXISTS`/CAS no resgate de convite; chave `driver-addr:drv_legacy_owner_000000000` órfã após a virada; um convidado ativo configurado por engano como `FINN_OWNER_DRIVER_ID` só é detectável pela marca "(dono)" e pela prova com a sessão `v1.` (roteiro).
12. Singleton do `MemoryDriverStore` em dev com bundles separados do Next (hipótese do qa), e build do cliente se o PWA importar o barrel `src/lib/driver` (importa `node:crypto`): não importar do PWA.

## Pré-lançamento (antes de abrir a usuários reais)

- [ ] Etapa 1 concluída e revisada (qa + security-review).
- [ ] Rate limit por motorista.
- [ ] Métricas de latência e de fallback.
- [ ] Restringir `NEXT_PUBLIC_PICOVOICE_ACCESS_KEY` no painel da Picovoice.
- [ ] Checklist `tests/MANUAL.md` rodada na build de produção.
- [ ] Spotify: avaliar extensão de cota se passar de 25 usuários.

## Pendências do dono

- [ ] Provisionar Upstash Redis (Marketplace da Vercel, região `gru1`) e avisar quando as variáveis estiverem no projeto. O agente só precisa dos nomes.
- [x] `FINN_SESSION_SECRET` e `FINN_INVITE_PEPPER`: feitos (ver Estado). Trocar o pepper invalida todos os convites emitidos.
- [ ] Mais tarde: `FINN_TOKEN_ENC_KEY` (entrega 4) e `FINN_LEGACY_TOKEN_ENABLED=1` (transitório, entrega 2).
- [ ] OK de merge de cada PR (ordem: #1, depois as entregas empilhadas).
- [ ] Autorizar push e PR da entrega 1 (a branch ainda é só local).

## Em aberto (do dono), em ordem de importância

Nenhuma decisão aberta no momento. (B3, vínculo de ambiente no token, fechada em 2026-10-26 como "não fazer".)

<!-- histórico da fila antes do fechamento:

1. **B3, vínculo de ambiente no payload do token** (muda o contrato). Prioridade baixa: os segredos de sessão já são distintos por ambiente, então um token de preview não valida em produção. Recomendação: não fazer.
-->
