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

No painel do Spotify (dono), cadastrar, byte a byte, a URI de cada ambiente e usá-la em `SPOTIFY_REDIRECT_URI` do mesmo ambiente, por exemplo `https://<dominio>/api/spotify/callback`. A mesma URI vai na autorização e na troca do `code`; se diferir, o Spotify recusa e o motorista vê a página de erro.

## Gerar o SPOTIFY_REFRESH_TOKEN do dono (só em desenvolvimento)

`GET /api/spotify/login` só funciona com `NODE_ENV=development` (`next dev`), em `http://127.0.0.1:<porta>` (a URI cadastrada deve ser essa). Abra o endereço, autorize, copie o token mostrado pelo callback para `SPOTIFY_REFRESH_TOKEN` (na Vercel, `vercel env add`). É o único lugar em que um token é exibido. Fora de desenvolvimento a rota responde 410.

## Revogar, desconectar, apagar

- **Revogar um motorista**: `npm run -s driver:revoke -- --env <ambiente> [--confirm-production] [--env-file <arquivo>] <driverId>`. Além de invalidar a sessão, apaga o token do Spotify guardado. Rodar de novo é seguro (só garante que o token sumiu).
- **Apagar dados sem revogar**: `npm run -s driver:purge -- --env <ambiente> [--confirm-production] [--env-file <arquivo>] <driverId>`. Apaga `spotify:<id>` e `driver-addr:<id>` (token e endereços). O motorista segue ativo e conecta o Spotify de novo. Pede confirmação; sem terminal exige `--yes`. `--env` é obrigatório e produção exige `--confirm-production`.
- **Desconectar (o próprio motorista)**: `DELETE /api/spotify/connection` com a sessão dele. Idempotente.
- O cache de access token (memória) é apagado na instância que atendeu a desconexão; em outras instâncias o access token já emitido vale até expirar (no máximo 1 hora). A revogação do motorista já bloqueia a sessão dele de imediato.

## Limites conhecidos

- Rate limit de `connect`: 10 por 600 s por motorista (contador no Redis).
- O `state` do OAuth vale 600 s e um uso só. Se o motorista demorar, toca em "Conectar Spotify" de novo.
- Convidados em produção só conectam o Spotify depois da entrega 5 (o PWA ainda não tem o botão).
