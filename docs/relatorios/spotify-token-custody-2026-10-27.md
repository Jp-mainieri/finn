# Relatório: entrega 4, custódia do refresh token do Spotify (feat/spotify-token-custody)
Contrato: `docs/contratos/custodia-token-spotify.md`. Modelo: Sonnet. 3 commits na ordem do contrato.
## Mudanças
- C1 `src/lib/spotify/token-crypto.ts` (AES-256-GCM, IV 12 B, AAD, `v1.iv.ct.tag`, chave falha fechada) e `token-vault.ts` (grava/lê/apaga; sem chave não escreve nem lê). `src/lib/driver/{store,memory-store,upstash-store,index}.ts`: blob (`spotify:<id>`, só aceita formato `v1.`), `oauth-state:<sha256>` (GETDEL, TTL 600), `purgeDriverData`, `revokeDriver` apaga o blob, `setDriverStoreForTests`. `auth.ts`: cache de access token e refresh em andamento por `driverId`; `getAccessToken({driverId})`, `evictSpotifyAccessToken`; rotação regravada cifrada; sem `err`/corpo do Spotify em log. `api.ts`, `player.ts`, `agents/spotify/tools.ts`: logs sem detalhe, `whoIs` só com `driverId`.
- C2 `src/lib/spotify/connect.ts` + rotas `connect` (POST), `callback`, `connection` (GET/DELETE), `login` (410 fora de `NODE_ENV=development`); `oauth.ts` ganhou CSP; `/api/orchestrator` não lê cookie nem token do corpo.
- C3 `scripts/lib/admin-cli.mjs` (`driver:purge`, `driver:revoke` apaga token, idempotente), `package.json` (script), `.env.example` (`FINN_TOKEN_ENC_KEY` comentado), `docs/procedimentos/custodia-token-spotify.md`, este relatório.
## Testes (`npm test && npm run typecheck && npm run lint && npm run build`)
- Linha de base 700 passaram, 4 ignorados. Final: 48 arquivos passaram, 1 ignorado; 782 passaram, 4 ignorados, 0 falharam. Por commit: C1 750, C2 776, C3 782. typecheck 0 erros, lint limpo, build ok (4 rotas spotify dinâmicas).
- Novos: `token-crypto.test.ts`, `token-vault.test.ts`, `driver/token-store.test.ts` (Memory e SDK real sobre REST falso), `app/api/spotify/spotify-routes.test.ts`, acréscimos em `isolation`, `api`, `agents/spotify`, `orchestrator/route`, `tests/scripts/admin-cli`, `tests/acceptance/driver-isolation`. Nenhum teste faz rede.
- Mutações executadas de verdade (cada uma revertida): (1) cache pelo `driverId` do dono: 6 testes falharam; (2) `driverId` do cookie no lugar do registro de state: 1 falhou ("stores the token under the driver of the STATE record"); (3) gravação em claro: com a trava do store 8+ falharam; sem a trava, 12 falharam, incluindo o espião de escritas; (4) `GET` no lugar de `GETDEL`: 3 falharam.
## Desvios
- `DriverContext.spotifyRefreshToken` NÃO foi removido: `src/lib/voice/orchestrator-client.ts:65` o lê e é proibido tocar. Ficou `@deprecated`, nunca lido pelo servidor. Remover na entrega 5.
- `driver:purge` exige o motorista existir no ambiente (proteção contra typo) e não exige que esteja revogado.
- `DriverStore` ganhou 6 métodos (blob, state, purge): mudança de interface, não de contrato congelado.
## Decisões técnicas
- Validação extra no store: só grava blob com formato `v1.` (defesa em profundidade contra gravação em claro).
- Chave: também rejeitada se igual a `FINN_A2A_TOKEN_NEXT` ou `FINN_API_TOKEN` (contrato listava três).
- Sem chave: motorista não dono ouve "O Spotify ainda não está configurado" (não "Conecte"); `GET connection` responde 503 (não `false`); `DELETE` funciona sem chave. Falha do Redis na leitura: "Não consegui acessar sua conta do Spotify agora." sem log.
- Callback: consome o state antes de qualquer outra checagem (também com `error=`); uma só página de erro (status 400/502/503); sem chave não consome o state. Modo dev do dono: só com `NODE_ENV=development` e cookie igual ao state; exibe o token sem script nem cookie; state do login subiu para 32 bytes.
- Dono que chamar `connect` grava blob que será ignorado (não bloqueei). `GET connection` do dono responde `false` (decisão do contrato em aberto: deveria ser `true`?).
## Não verificado
- Nada contra Upstash, Vercel ou Spotify reais; `GETDEL` e `SET ... EX` só contra REST falso (o SDK 1.40.0 tem `getdel`; a resposta real não foi vista).
- Access token em cache continua valendo em outras instâncias até 1 h após desconexão; refresh em voo durante a desconexão pode regravar o blob rotacionado.
- Falha ao regravar token rotacionado só gera aviso fixo (o próximo refresh pode falhar se o Spotify invalidou o antigo).
- Smoke em preview, PWA real e `next dev` com o fluxo do dono não foram rodados. `process.env.VITEST` em `agents/spotify/tools.ts` segue (fora do escopo). Sem qa/security-review ainda.

# Rodada 2 (qa e security-review)
Fontes: `docs/revisoes/spotify-custody-{qa,security-review}.md` e o histórico do contrato (não editados). Um commit novo sobre 05e4057.
## Mudanças
- B1 qa: `flat()`/`loggedText()` em `src/lib/spotify/testing.ts` expandem Error (message, stack, cause); `logged()` de `spotify-routes.test.ts` e dos testes curados os usam; os testes de varredura de log do qa foram adotados.
- sec M1/qa N4 (a): `src/lib/spotify/profile.ts` (`/v1/me`, 5 s, null em qualquer falha), `getOwnerSpotifyUserId` (cache em memória; pula sem `SPOTIFY_REFRESH_TOKEN`; falha fechada se a consulta falhar). Callback recusa conta do dono e conta de outro motorista (`spotify-index` SET NX + ponteiro `spotify-account:<driverId>`); troca de conta libera a ligação antiga; `DELETE`, `purge`, `revoke` liberam só a do motorista (UNLINK compare-and-delete). Página de sucesso com o rótulo escapado.
- N5: dono = `Boolean(SPOTIFY_REFRESH_TOKEN)` sem vault; `connect` 403; vault recusa id legado; `DELETE` legado segue. N3: callback exige `getDriver` ativo. N1/B1: `SET XX` (`setSpotifyBlobIfExists`), época por driver e `hasSpotifyBlob`: refresh em voo não recria blob nem cache. N2: `finally` por identidade. N6: `isDevelopmentFlow` (NODE_ENV e VERCEL_ENV). B3: redirect URI obrigatória em produção. N9: timeout de 5 s na troca do code e no `/me`.
- Curadoria: `tests/qa/*` virou `tests/acceptance/spotify-custody.test.ts` (tests/qa removido); FINDING N1, N2, N3, N5, N6 invertidos; débitos com nome "debt" (cookie de amarração, N7, N10, purge de motorista ativo). Novos testes em `token-store.test.ts` (XX, NX, link, UNLINK) e `isolation.test.ts`.
## Testes
`npm test && npm run typecheck && npm run lint && npm run build`: 49 arquivos passaram, 1 ignorado; 854 passaram, 4 ignorados, 0 falharam (782 antes, sem tests/qa). typecheck 0 erros, lint limpo, build ok.
## Mutações executadas (cada uma derrubou testes, depois revertida)
Log de `err` no erro de token (1), refresh token no aviso de rotação do dono (2) e do motorista (1), refresh token no log do endpoint de token (1), `err` no log da Web API (1); sem checagem da conta do dono (1); conflito de link ignorado (3); sem checagem de motorista ativo (2); regravação sem XX (3); sem checagem de época (1); `finally` sem identidade (1); gate dev só NODE_ENV (1); fallback de redirect em produção (1); sem timeout na troca (1) e no `/me` (1); dono lido pelo vault (1); `connect` do dono liberado (1); vault aceitando id legado (2); `DELETE` sem liberar link (4). Sobrevivente: UNLINK sem comparação na Memory (equivalente: ponteiro obsoleto não se forma lá); no Upstash o teste só confere o ARGV, não o Lua.
## Desvios
- `driver:purge` de motorista ativo continua deixando um state anterior completar (conexão nova do mesmo motorista); revogado/inexistente é recusado.
- A falha do `/v1/me` e a de ligação usam 502/400 com a mesma página; Redis fora no link/gravação: 502.
## Não verificado
- Lua de UNLINK, `SET NX/XX` e `GETDEL` nunca rodaram em Upstash real (só REST falso); `/v1/me` real não visto (campos `id`/`display_name` assumidos).
- Índice órfão se o processo morrer entre o SET NX e o ponteiro (a conta fica presa; resolvido por `driver:purge`); ordem link, depois blob: falha ao gravar o blob deixa o link do motorista.
- Corrida entre instâncias e `AbortSignal.timeout` real; smoke em preview e PWA; qa/security-review da rodada 2.
