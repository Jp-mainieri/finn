# Procedimento: custódia do refresh token do Spotify

Contrato: [`custodia-token-spotify.md`](../contratos/custodia-token-spotify.md). Quem executa é o dono (Vercel, Upstash e Spotify são do dono); o agente só mantém este roteiro. Nunca cole valores (chave, token, `state`, `code`, blob) em chat, commit, ticket ou log.

## O que é

O refresh token de cada motorista fica só no servidor: cifrado (AES-256-GCM) na chave Redis `finn:<env>:spotify:<driverId>`, sem TTL. O aparelho nunca o recebe. O dono continua no `SPOTIFY_REFRESH_TOKEN` do servidor e ignora qualquer token que o cliente mande.

## Variável nova

`FINN_TOKEN_ENC_KEY`: 64 hex (`openssl rand -hex 32`), pelo menos 8 caracteres distintos, **uma por ambiente** (production, preview, development) e diferente de `FINN_SESSION_SECRET`, `FINN_INVITE_PEPPER`, `FINN_A2A_TOKEN`, `FINN_A2A_TOKEN_NEXT` e `FINN_API_TOKEN`. Ausente ou inválida: `POST /api/spotify/connect` e `GET /api/spotify/connection` respondem 503, o callback mostra a página de erro e motoristas que não são o dono ouvem "O Spotify ainda não está configurado". Nada é gravado nem lido em claro.

Criar na Vercel (`vercel env add FINN_TOKEN_ENC_KEY <ambiente>`) e fazer redeploy. Em dev local com `FINN_USE_MOCKS=1` a chave só é necessária para testar a conexão de um convidado.

## Trocar ou perder a chave

Trocar `FINN_TOKEN_ENC_KEY` invalida todos os tokens guardados (não há rotação com duas chaves nesta entrega). Os blobs antigos passam a valer como "não conectado": cada motorista toca em "Conectar Spotify" de novo (máximo de 25 usuários no modo de desenvolvimento do Spotify). Não precisa apagar nada; o blob antigo é sobrescrito na reconexão. Se o vazamento for da chave, trocar a chave e, por segurança, rodar `driver:purge` dos motoristas sensíveis.

## Registrar a redirect URI no Spotify

Em `VERCEL_ENV=production` a variável `SPOTIFY_REDIRECT_URI` é **obrigatória**: sem ela `connect` responde 503 e o callback falha fechado (não consome o `state`, não troca o `code`). Em preview e desenvolvimento, sem ela, vale a origem da requisição.

No painel do Spotify (dono), cadastrar, byte a byte, a URI de cada ambiente e usá-la em `SPOTIFY_REDIRECT_URI` do mesmo ambiente, por exemplo `https://<dominio>/api/spotify/callback`. A mesma URI vai na autorização e na troca do `code`; se diferir, o Spotify recusa e o motorista vê a página de erro.

## Gerar o SPOTIFY_REFRESH_TOKEN do dono (só em desenvolvimento)

`GET /api/spotify/login` só funciona com `NODE_ENV=development` (`next dev`), em `http://127.0.0.1:<porta>` (a URI cadastrada deve ser essa). Abra o endereço, autorize, copie o token mostrado pelo callback para `SPOTIFY_REFRESH_TOKEN` (na Vercel, `vercel env add`). É o único lugar em que um token é exibido. Fora de desenvolvimento a rota responde 410.

## Revogar, desconectar, apagar

- **Revogar um motorista**: `npm run -s driver:revoke -- --env <ambiente> [--confirm-production] [--env-file <arquivo>] <driverId>`. Além de invalidar a sessão, apaga o token do Spotify guardado. Rodar de novo é seguro (só garante que o token sumiu).
- **Apagar dados sem revogar**: `npm run -s driver:purge -- --env <ambiente> [--confirm-production] [--env-file <arquivo>] <driverId>`. Apaga `spotify:<id>` e `driver-addr:<id>` (token e endereços). O motorista segue ativo e conecta o Spotify de novo. Pede confirmação; sem terminal exige `--yes`. `--env` é obrigatório e produção exige `--confirm-production`.
- **Desconectar (o próprio motorista)**: `DELETE /api/spotify/connection` com a sessão dele. Idempotente.
- O cache de access token (memória) é apagado na instância que atendeu a desconexão; em outras instâncias o access token já emitido vale até expirar (no máximo 1 hora). A revogação do motorista já bloqueia a sessão dele de imediato.

## Uma conta do Spotify, um motorista

Depois da troca do `code`, o callback consulta `GET /v1/me` e grava `spotify-index:<spotifyUserId>` → `driverId` (`SET NX`; ponteiro inverso em `spotify-account:<driverId>`). Recusa (página de erro genérica, nada gravado) a conta do dono (a do `SPOTIFY_REFRESH_TOKEN`) e qualquer conta já ligada a outro motorista. O mesmo motorista pode reconectar; trocar de conta libera a ligação anterior dele. `DELETE /api/spotify/connection`, `driver:purge` e `driver:revoke` liberam a ligação do motorista (e só a dele): a conta volta a poder ser usada por outro. Nas três operações o token é apagado **primeiro** e a ligação é liberada depois: uma falha ao liberar a ligação nunca deixa o token para trás (a operação devolve erro genérico e pode ser repetida).

**Conta presa.** `driver:purge` (e `driver:revoke`) liberam a conta pelo ponteiro inverso `spotify-account:<driverId>`. Um índice órfão **sem ponteiro** NÃO é liberado por nenhum comando: acontece se o processo morrer entre o `SET NX` e a gravação do ponteiro, ou com dois callbacks paralelos do mesmo motorista com contas diferentes. Limpeza manual do dono: no painel do Upstash do ambiente, confirmar que a chave `finn:<env>:spotify-index:<spotifyUserId em minúsculas>` guarda o `driverId` esperado e apagar só essa chave (o motorista então conecta de novo). Um comando do script para isso é débito futuro; não existe hoje.

O dono (id legado, `FINN_API_TOKEN`) usa o token do servidor: `GET /connection` responde `connected` conforme `SPOTIFY_REFRESH_TOKEN` existir, `POST /connect` responde 403. Um dono que entre por convite tem id comum e usa o fluxo normal.

## Limites conhecidos

Aceitos (decididos pelo dono, sem CAS em EVAL por enquanto):
- **M1**: uma reconexão feita durante um refresh em voo pode perder para a gravação do token rotacionado da conta antiga (só se o Spotify rotacionar o refresh token; hipótese não observada). O motorista reconecta.
- **B1**: um `revoke` que chega durante a troca do `code` pode deixar blob e ligação de um motorista já revogado; `driver:purge` ou `driver:revoke` de novo limpa.
- **B3**: um `DELETE` em corrida com o callback do mesmo motorista pode deixar blob sem ligação. Repetir o `DELETE`.
- **B6**: `SPOTIFY_REDIRECT_URI` só é obrigatória com `VERCEL_ENV=production`; em preview e desenvolvimento vale a origem da requisição.

- Rate limit de `connect`: 10 por 600 s por motorista (contador no Redis).
- O `state` do OAuth vale 600 s e um uso só. Se o motorista demorar, toca em "Conectar Spotify" de novo.
- Convidados em produção só conectam o Spotify depois da entrega 5 (o PWA ainda não tem o botão).
