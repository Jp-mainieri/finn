# Relatório: expirar cookie legado finn_spotify_rt (achado M1)

Branch: fix/expire-legacy-spotify-cookie (sobre feat/pwa-invite-session). Modelo: Sonnet.

## O que mudou
- src/lib/spotify/oauth.ts: `LEGACY_REFRESH_COOKIE` e `expireLegacyRefreshCookie(env)`, única fonte do Set-Cookie: `finn_spotify_rt=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`. Secure some só em `isDevelopmentFlow` (mesma regra de desenvolvimento local do oauth.ts).
- src/lib/spotify/connect.ts: `handleConnectionStatus` e `handleDisconnect` devolvem o Set-Cookie nas respostas 200 autenticadas (dono e motorista). 401, 403, 429 e 503 não trazem. O valor do cookie recebido nunca é lido nem logado. connect, callback e session intocados.
- Testes em src/app/api/spotify/spotify-routes.test.ts: GET e DELETE 200 trazem o cookie exato (nome, Max-Age=0, Path=/, HttpOnly, sem valor); 401 e 503 não; Secure só fora de dev local.

## Comandos e contagens
- `npm test`: 58 arquivos passaram, 1 ignorado; 1139 testes passaram, 4 ignorados.
- `npm run typecheck`, `npm run lint`, `npm run build`: saída 0.
- orchestrator/route.test.ts (cookie finn_spotify_rt ignorado): segue passando.
- Mutação: trocar o header Set-Cookie por outro nome derrubou o teste novo (1 falha, 25 passaram no arquivo); revertida.

## Não verificado
- Comportamento em navegador real (iOS/Safari) de expirar o cookie; só o cabeçalho foi testado.
- Respostas 403/429/503 sem o cookie: o 503 é testado, 403/429 não.
- Nada rodado em produção.

## Desvios
- Nenhum. O cookie não é mais gravado por oauth.ts; a função foi criada ali como pedido. Áreas críticas (sessão/token): qa e security-review ainda pendentes.
