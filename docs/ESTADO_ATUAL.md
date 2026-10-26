# Finn — estado atual

Atualizado em 2026-10-26. Processo: [`ORQUESTRACAO.md`](./ORQUESTRACAO.md). Arquitetura: [`ARCHITECTURE.md`](./ARCHITECTURE.md). Plano: [`PERSONALIZATION_AND_LEARNING.md`](./PERSONALIZATION_AND_LEARNING.md).

## Estado

- MVP funcionando no carro (iPhone PWA, v0.5.8). Wake word Porcupine, STT Groq Whisper, Neuralake + fallback Groq, agentes Spotify e Waze.
- `main` limpo e sincronizado. 379 testes passam (4 pulados live), typecheck e lint limpos (2026-10-26).
- Sem CI. Lote completo roda localmente, uma vez por branch.
- Persistência: nenhuma durável em `main`. Endereços ditados vivem na memória da função (somem no cold start).
- Upstash for Redis (`finn-upstash`) provisionado pelo dono em 2026-10-26, nos 3 ambientes (Development, Preview, Production), **mesmo banco e mesma credencial**. Variáveis presentes: `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `KV_REST_API_READ_ONLY_TOKEN`, `KV_URL`, `REDIS_URL`.
- Etapa 1, entrega 1 (núcleo `src/lib/driver/`): implementada e corrigida após qa e security-review, em `feat/driver-store-core` (local, sem PR ainda). Relatórios: [`relatorios/driver-store-core-2026-10-26.md`](./relatorios/driver-store-core-2026-10-26.md), [`revisoes/driver-store-core-security-review.md`](./revisoes/driver-store-core-security-review.md), [`relatorios/orquestrador-2026-10-26.md`](./relatorios/orquestrador-2026-10-26.md). Rodada 3 (pepper do convite e `rotateSessions`) concluída: 442 testes passam, typecheck e lint limpos. Falta: push e PR (aguarda OK do dono), depois entrega 2.
- PRs: #1 adoção do padrão (aberto, sem merge). Entrega 1 empilha sobre #1 e sobre a branch do contrato.

## Decisões fechadas

- 2026-10-22: voz STT+TTS padrão; GPT-Live-1 bloqueado por custo (`ENABLE_GPT_LIVE=1`).
- 2026-10-22: fast-path de 1 round-trip (`FINN_FAST_SPEECH=1`).
- 2026-10-22: multi-user stateless via `driverContext` (a ser substituído pela etapa 1).
- 2026-10-26: ordem de evolução: (1) Redis + `DriverProfile` + identidade, (2) memória curta da viagem, (3) lugares dinâmicos e aliases, depois rate limit e observabilidade antes de abrir o beta, (4) Modo Rotina. Camada 4 do plano espera.
- 2026-10-26: o beta será aberto a outras pessoas, mas só com acesso controlado pelo dono.

- 2026-10-26: após o security-review da entrega 1, o dono aprovou duas adições ao contrato: pepper HMAC (`FINN_INVITE_PEPPER`) no hash do convite e `rotateSessions` (incrementa `tokenVersion` sem banir o motorista). Motivo: baratas agora, caras depois de haver convites emitidos.
- 2026-10-26: decisões técnicas do agente aceitas (provisórias, ajustáveis por parâmetro): rate limit do resgate 10 por 600 s por IP; IP ausente ou inválido cai num balde próprio de 3 por 600 s; teto de espera do Redis 2 s sem retry (o EVAL de resgate nunca é retentado); tempo em ms em `expiresAt`, em s em `iat`/`exp`.

## Decisões provisórias

- **Identidade (opção B, 2026-10-26):** `driverId` opaco gerado pelo servidor; token de sessão assinado, emitido em troca de código de convite criado e revogável pelo dono. O Spotify ID é só atributo ligado ao perfil (índice `spotify:<id> → driverId`). Substitui o `FINN_API_TOKEN` compartilhado.
  - Convites criados e revogados por script local rodado pelo dono (sem rota de admin). Contrato aprovado em 2026-10-26: [`contratos/identidade-e-perfil.md`](./contratos/identidade-e-perfil.md).
  - Reabre se: for preciso convidar pelo celular com frequência (rota de admin), for preciso login sem convite (migrar para OAuth Spotify, opção C, só troca a forma de emitir o token), ou o OAuth quebrar no iOS standalone PWA.

## Casos cinzentos aceitos

- OAuth do Spotify dentro de PWA standalone no iOS: comportamento do redirect não verificado. Desenho esperado: abrir fora do PWA e voltar com o token já emitido pelo servidor.
- Modo desenvolvimento do Spotify limita a 25 usuários cadastrados à mão; acima disso exige extensão de cota.

## Débitos

1. Perfis misturados: `LayeredAddressBook` grava também no `baseBook` global (vazamento entre motoristas). Etapa 1, entrega 2.
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
- [ ] Gerar e adicionar na Vercel, **um valor diferente por ambiente** (`openssl rand -hex 32`): `FINN_SESSION_SECRET` e `FINN_INVITE_PEPPER` (independentes entre si; trocar o pepper invalida todos os convites emitidos). Mais tarde: `FINN_TOKEN_ENC_KEY` (entrega 4) e `FINN_LEGACY_TOKEN_ENABLED=1` (transitório, entrega 2). Valores são do dono.
- [ ] OK de merge de cada PR (ordem: #1, depois as entregas empilhadas).
- [ ] Autorizar push e PR da entrega 1 (a branch ainda é só local).

## Em aberto (do dono), em ordem de importância

1. **M2, credencial do Redis compartilhada** entre dev, preview e produção: o prefixo de chaves não protege contra bug ou vazamento da credencial. Opções: manter, ou Redis separado para produção. A trazer com opções na entrega 2.
2. **B3, vínculo de ambiente no payload do token** (muda o contrato). Prioridade baixa; depende da resposta do M2.
