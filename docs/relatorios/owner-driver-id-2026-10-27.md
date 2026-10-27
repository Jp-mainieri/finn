# Entrega 5a: dono registrado no servidor (2026-10-27)

Branch `feat/owner-driver-id`, 2 commits. Contrato: `docs/contratos/pwa-convite-e-dono.md` (5a e Invariantes).

## 1. O que mudou
Commit 1 (dono):
- `src/lib/auth.ts`: `getOwnerDriverId(env?)`, `isOwner(id, env?)`, `resetOwnerLogForTests`. Dono = `FINN_OWNER_DRIVER_ID` válida (regex de `isValidDriverId`, valor exato) ou, só com `FINN_LEGACY_TOKEN_ENABLED=1`, o id legado; senão `undefined`. Inválida = ausente, um log fixo por processo sem valor. Lê o ambiente a cada chamada (sem cache). Token legado mapeia para o dono em vigor. `authorizeA2A` e `guardA2A` dão 503 sem dono (antes de tocar no Redis).
- `src/lib/a2a-server.ts`: A2A roda como `getOwnerDriverId()`; sem dono, recusa (segunda trava, o agente não é chamado).
- `src/lib/spotify/auth.ts`, `connect.ts`, `token-vault.ts`, `src/lib/waze/address-book.ts`: todo uso de `LEGACY_OWNER_DRIVER_ID` como "dono" virou `isOwner`/`getOwnerDriverId`. 403 de connect, recusa em `saveSpotifyRefreshToken`, `connected` por `SPOTIFY_REFRESH_TOKEN`, DELETE limpando blob residual e recusa da conta do dono em `/v1/me` seguem valendo para o dono.
- `.env.example`: `FINN_OWNER_DRIVER_ID` comentado, com formato.
- Testes: `tests/helpers/owner.ts` (`TEST_OWNER_ID`, seta a variável ao importar); 12 arquivos de teste trocaram o id legado pelo dono de teste; novo `src/lib/owner.test.ts` (25 testes).
Commit 2 (driverContext): removido de `AgentTaskInput`, de `orchestrate.ts` e da rota `/api/orchestrator`; `waze/tools.ts` e `agent-runtime.ts` não emitem mais `save_address`. Tipos `DriverContext`, `OrchestratorRequest.driverContext` e `SaveAddressAction` ficam `@deprecated` ("removido na 5b") só para `src/lib/voice` e `src/components` compilarem; o servidor os ignora. Testes de `driverContext` viraram "ignorado, nunca emite save_address".

## 2. Testes rodados
Linha de base: 857 passaram, 4 ignorados. Final: `npm test` = 882 passaram, 4 ignorados, 0 falharam (50 arquivos + 1 ignorado); `npm run typecheck` 0 erros; `npm run lint` 0 erros, 0 avisos; `npm run build` ok. Nenhum teste de `src/lib/voice/**` quebrou. Sem rede, Redis em fake de memória.
Mutações executadas (código restaurado depois de cada uma):
- `isOwner` sempre verdadeiro: 107 falhas.
- Legado sempre dono, ignorando a flag: 6 falhas (owner.test). Variante `isOwner` aceitando o id legado: 6 falhas.
- Token legado mapeando para o id legado em vez do real: 10 falhas.
- A2A sem dono rodando: 1 falha em `authorizeA2A`/`guardA2A`, 1 falha ao tirar a segunda trava em `handleA2ARequest`.
- Extra: desligar a invalidação do cache de access token por mudança de dono: 2 falhas.

## 3. Não verificado
- Nada contra Vercel, Upstash ou Spotify reais; `FINN_OWNER_DRIVER_ID` não existe na Vercel (orquestrador cria).
- Segurança e qa independentes ainda não rodaram (obrigatórios).
- Refresh em andamento (`pendingRefresh`, por driverId) iniciado antes de uma troca de dono no mesmo processo não é invalidado (janela de 1 refresh, só com mudança de env em runtime, que não ocorre em produção).
- Mutação do `driverContext` ignorado não foi executada (coberto por testes de rota, orquestrador e acceptance).

## 4. Decisões para o dono
Nenhum item aberto novo.

## 5. Desvios e decisões técnicas minhas
- Cache de access token ganhou o campo `owner`: entrada só é servida se o id continua do mesmo tipo (dono ou não). Evita que token do servidor sobreviva à perda do dono. Padrão: cache nunca guarda "quem é dono", só a origem de cada entrada, conferida na leitura.
- `getOwnerSpotifyUserId`: com `SPOTIFY_REFRESH_TOKEN` presente e sem dono, falha fechada (lança, quem chama recusa) em vez de ler o token do servidor para consultar `/v1/me`. Efeito: após remover a flag legada sem definir `FINN_OWNER_DRIVER_ID`, o connect de convidados falha (502) enquanto `SPOTIFY_REFRESH_TOKEN` existir na Vercel. Convém o roteiro de virada definir a variável antes de remover a flag.
- `getOwnerDriverId`/`isOwner` aceitam `env` opcional para as rotas que já recebem `deps.env`.
- Variável vazia = ausente, sem log; só valor não vazio e inválido loga.
- Testes existentes passaram a importar `tests/helpers/owner` (efeito colateral de ambiente) em vez de depender do id legado.

# Rodada 2 (qa e security-review), um commit sobre 638f7b6

## 1. O que mudou
- `src/lib/auth.ts`: (qa N1) `getOwnerDriverId` aplica `.trim()` ao valor (espaço, `\n`, `\r` nas pontas); aspas e espaço no meio seguem inválidos; a comparação do id continua exata. (qa N4) o id legado é inválido como valor da variável (ausente, com o log fixo), mesmo com a flag desligada. (sec M1/qa N3) com dono real, o token legado e o A2A só valem se `getDriver(dono)` existir e estiver `active`: legado revogado/inexistente = 401, store fora = 503 de indisponibilidade; A2A = 503 "A2A endpoint disabled" (checado só depois do Bearer correto; o limitador segue antes do Bearer e não é alterado). Dono = id legado: sem checagem. `rotate` não corta nenhum dos dois.
- `scripts/lib/admin-cli.mjs` (sec M2/B2): `driver:list` marca "(dono)" pelo `FINN_OWNER_DRIVER_ID` do ambiente do script (aviso curto se ausente/inválida); `revoke`, `purge` e `rotate` imprimem "ATENÇÃO: este motorista é o DONO" com o efeito, mantêm a confirmação (prefixo "[DONO]") e o `--yes` sem TTY. Nenhum id novo em saída.
- Testes: `tests/helpers/owner.ts` agora também registra o dono (ativo) no store global e exporta `registerTestOwner(store, status?)`; `src/lib/owner.test.ts` (36 testes, 11 novos); `tests/scripts/admin-cli.test.ts` (+5 do dono).
- Curadoria: `tests/qa/` movido para `tests/acceptance/owner-5a-attack.test.ts` e `old-pwa-driver-context.test.ts`; asserções de N1, N3 e N4 invertidas (nomeadas "fixed"); ficam como "debt": endereços órfãos (N2), refresh em voo e ramo inalcançável. `tests/qa` não existe mais.
- Doc: `docs/procedimentos/dono-registrado.md` (definir a variável com `printf %s`, formato, inválida, conferir com sessão `v1.` antes de remover a flag, efeito de revogar/rotacionar/purgar o dono, endereços órfãos sob o id legado).

## 2. Testes rodados
Linha de base do HEAD 638f7b6: 882 passaram, 4 ignorados. Agora, lote completo `npm test && npm run typecheck && npm run lint && npm run build`: 966 passaram, 4 ignorados, 0 falharam (52 arquivos + 1 ignorado, incluindo os 2 de tests/acceptance vindos do qa); typecheck 0 erros; lint 0 avisos; build ok.
Mutações executadas numa CÓPIA em `scratchpad/mut` (fora do repositório; base 793 passando nos diretórios src/lib, tests/acceptance, tests/scripts):
- remover a checagem de `active` (só existência): 3 falhas; remover também a de existência: 4 falhas.
- remover a checagem do dono no A2A: 5 falhas; no token legado: 5 falhas; store fora liberando o A2A: 1 falha.
- remover o `.trim()`: 8 falhas; aceitar o id legado como valor da variável: 3 falhas.
- CLI sem a marca "(dono)": 1 falha; sem o aviso do dono: 3 falhas.
Cada mutação foi revertida (a cópia é descartável); o repositório não foi mutado.

## 3. Não verificado
- Vercel, Upstash e Spotify reais; se a Vercel preserva `\n` ao criar a variável (agora tolerado de qualquer forma).
- `driver:purge` do dono contra o Upstash real (o `MemoryDriverStore` não modela o hash de endereços).
- Mutação de "store fora" no caminho do token legado (o 503 é coberto por teste, sem mutação própria).
- O CLI lê `FINN_OWNER_DRIVER_ID` só de `process.env`/`--env-file`; sem a variável no ambiente do script não há aviso de alvo-dono em revoke/purge/rotate (só no `driver:list`).
- Segurança e qa não reexecutaram sobre este commit.

## 4. Desvios
- `authorizeA2A` (síncrono, sem store, usado só em testes) não faz a checagem do dono ativo; a rota usa `guardA2A`, que faz. Anotado, sem mudança.
- Item 5: o `driver:purge` do dono, por não haver teste Upstash, ficou só no CLI mock.
- Nada dos itens "NÃO FAZER" foi tocado.
