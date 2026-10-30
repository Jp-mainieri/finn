# Security review pontual: rodada 2 da custódia do token do Spotify (commit 180d533)

Escopo: só `git diff 05e4057..180d533` e o que ele toca. Esta revisão não é completa. Ela não aprova merge, só relata.

## Resumo

- **Crítico:** nenhum. **Alto:** nenhum. **Médio:** 1. **Baixo:** 6. **Informativo:** 6.
- **Fechados (Fato):**
  - Um blob apagado não volta mais. O `SET ... XX` cobre DELETE, revoke e purge durante um refresh em voo.
  - O callback agora confere se o motorista está ativo.
  - `SPOTIFY_REDIRECT_URI` é obrigatória quando `VERCEL_ENV=production`.
  - O dono não grava blob: `connect` responde 403, o callback recusa e `saveSpotifyRefreshToken` lança erro.
  - Os arquivos novos não logam nada sensível.
  - A página de sucesso escapa o rótulo.
- **Continua aberto (Fato, provado com PoC):**
  - Uma reconexão durante um refresh em voo ainda troca o blob novo pelo token rotacionado da conta antiga. Este é o sub-caso "reconexão" do B1 anterior, e agora ele também desfaz o índice de conta (M1).
  - Um revoke que chega durante a troca do `code` ainda deixa blob e ligação para um motorista revogado (B1).
- **Comandos que rodei:**
  - `npx vitest run src/lib/driver/token-store.test.ts src/app/api/spotify/spotify-routes.test.ts src/lib/spotify/isolation.test.ts tests/acceptance/spotify-custody.test.ts`: 4 arquivos, 129 testes passaram e 0 falharam.
  - PoC fora do repositório, no scratchpad, com config própria do vitest e `MemoryDriverStore`: 2 testes, os 2 reproduziram os achados M1 e B1.
  - Não rodei o lote completo (`npm test && npm run typecheck && npm run lint`). Não usei Redis real.

## Médio

### M1. O token rotacionado da conta antiga sobrescreve o blob de uma reconexão e deixa o índice mentindo (Fato, PoC; frequência, Hipótese)

- **Fato:**
  - `refreshFor` grava o token rotacionado com `saveRotatedSpotifyRefreshToken` (`src/lib/spotify/auth.ts:169-171`). Isso acontece antes da checagem de época (`auth.ts:181`).
  - O `SET ... XX` (`src/lib/driver/upstash-store.ts:223`) só exige que exista algum blob. Ele não exige que seja o mesmo blob que foi lido.
  - O PoC faz isto: refresh em voo com o RT da conta X1, reconexão com a conta X2 (link, save e evict), e o Spotify devolve um RT rotacionado. Resultado: o blob termina com o RT rotacionado de X1. A época só impede o cache. Ela não impede a gravação, nem na mesma instância.
- **Efeito:**
  - O índice diz `spotify-index:x2 -> D`, `spotify-account:D = x2` e `x1` livre.
  - O cofre de D, porém, controla X1.
  - Se X1 depois for ligada a outro motorista E, os dois guardam token da mesma conta. Isso quebra "uma conta, um motorista" e torna dado de E alcançável por D.
- **Hipótese:**
  - O Spotify rotaciona o refresh token no fluxo authorization code com client secret? O habitual é só no PKCE.
  - A janela é a latência de um refresh, de centenas de ms.
- **Correção sugerida:**
  - Gravar o token rotacionado com compare-and-set atômico. Exemplo de EVAL: `if GET(KEYS[1]) == ARGV[1] then SET(KEYS[1], ARGV[2]) return 1 end return 0`, com o blob lido em `loadSpotifyRefreshToken` como ARGV[1]. Era a correção do B1 anterior.
  - Checar a época antes de gravar ajuda só na mesma instância.
  - Teste: reconexão com outra conta durante um refresh que rotaciona. O blob deve continuar o da conta nova.
- **Não verificado:** comportamento em Redis real e em várias instâncias.

## Baixo

### B1. Revoke durante o callback ainda grava blob e ligação de motorista revogado (Fato, PoC)

- **Fato:**
  - O status é lido uma vez (`src/lib/spotify/connect.ts:127-128`). Depois vêm a troca do `code` (até 5 s), `/v1/me` (até 5 s), o refresh do dono (sem timeout, ver B5), o link e o save (`connect.ts:130-142`).
  - No PoC, `revokeDriver` entra durante a troca. A resposta é 200, o driver fica `revoked`, o blob fica PRESENT e a ligação também.
- **Impacto:**
  - A sessão revogada recebe 401, então o token não é alcançável.
  - Mesmo assim, viola "revogar apaga o token" e prende a conta Spotify ao revogado.
  - O remédio é rodar `driver:revoke` de novo. Ele é idempotente e o ponteiro existe.
- **Correção sugerida:**
  - Gravar blob e ligação num EVAL que confira `HGET driver status == 'active'`.
  - Ou reler o status depois do save e desfazer com `deleteSpotifyBlob` se não estiver ativo.

### B2. A ligação não é atômica: há órfãos que nem DELETE, nem purge, nem revoke liberam (Fato no código; queda do processo, Hipótese)

- **Fato:**
  - `linkSpotifyAccount` faz `SET NX` no índice, depois `GET` e `SET` do ponteiro e depois `EVAL` de unlink, em 3 a 4 comandos separados (`upstash-store.ts:256-268`).
  - `unlinkAccount` só acha o índice pelo ponteiro (`upstash-store.ts:236-237`).
- **Casos:**
  - (a) O processo morre ou dá timeout entre o `SET NX` (256) e o `SET` do ponteiro (264). O índice aponta para D sem ponteiro, e nenhuma limpeza de D o encontra. Só D reconectando a mesma conta conserta. Se D for revogado, a conta fica presa para sempre.
  - (b) Dois callbacks do mesmo D, com contas diferentes e em paralelo, leem `old = null` (263). O primeiro índice fica órfão.
  - (c) O resultado do `EVAL` em 267 não é conferido, ao contrário de 240-241.
- **Doc:** `docs/procedimentos/custodia-token-spotify.md:38` manda rodar `driver:purge` para uma conta presa. Isso não funciona no caso (a), porque o purge depende do ponteiro.
- **Impacto:** disponibilidade, uma conta Spotify bloqueada. Não há confidencialidade envolvida.
- **Correção sugerida:**
  - Fazer a ligação num único EVAL com 3 KEYS (índice novo, ponteiro e índice antigo lido dentro do script): `SET NX` ou "já é meu", `GETSET` do ponteiro e compare-and-delete do antigo.
  - Para os órfãos já existentes, criar um comando do dono que libere `spotify-index:<id>` quando o motorista apontado estiver revogado ou não existir.
  - Corrigir a doc.

### B3. Um DELETE em corrida com o callback do mesmo motorista deixa blob sem ligação (Fato no código)

- **Fato:** a ordem é link no callback (`connect.ts:139`), depois o DELETE do mesmo D (unlink e DEL), depois o save no callback (142). O resultado é D conectado à conta X, com X livre no índice.
- **Impacto:** outro motorista pode ligar X, se X consentir. Exige que o próprio D cause a corrida.
- **Correção:** a mesma do B1 ou do B2: link e save atômicos, ou conferir o ponteiro depois do save.

### B4. DELETE, revoke e purge agora dependem do unlink ANTES de apagar o token (Fato; regressão leve)

- **Fato:** `deleteSpotifyBlob` e `purgeDriverData` chamam `unlinkAccount` primeiro (`upstash-store.ts:246`, `302`). Se ele lançar erro (Redis instável, `WRONGTYPE` no índice ou no ponteiro), o `DEL` do blob não roda.
- **Antes do commit:** o revoke apagava o blob direto.
- **Impacto:** o revoke já marcou `revoked` (`upstash-store.ts:199`) e o CLI mostra erro. O token fica até alguém tentar de novo.
- **Correção:** apagar `spotify:<id>` primeiro, que é o dado sensível, e liberar o índice depois. O ponteiro pode ser apagado junto com o unlink.

### B5. A consulta da conta do dono roda sem timeout e lê `process.env`, não `deps.env` (Fato)

- **Fato:**
  - `getOwnerSpotifyUserId` chama `getAccessToken({ driverId: LEGACY_OWNER_DRIVER_ID })` sem `signal` (`src/lib/spotify/auth.ts:246`). Assim, `requestToken` faz o `fetch` sem timeout.
  - Com o Spotify lento, o callback fica preso até o limite da plataforma. Isso alarga a janela do B1.
  - A função lê `process.env.SPOTIFY_REFRESH_TOKEN` (244), enquanto o callback usa `deps.env`.
- **Correção:**
  - Passar `AbortSignal.timeout(SPOTIFY_HTTP_TIMEOUT_MS)`.
  - Receber `env` como parâmetro.

### B6. `SPOTIFY_REDIRECT_URI` só é exigida com `VERCEL_ENV=production` (Fato; exploração, Hipótese)

- **Fato:** com `VERCEL_ENV=preview`, ou com `NODE_ENV=production` sem `VERCEL_ENV` (self-host), vale a origem da requisição (`src/lib/spotify/oauth.ts:12-17`).
- **Regra do projeto:** o CLAUDE.md define produção como qualquer `NODE_ENV`/`VERCEL_ENV` diferente de `development` e `test`.
- **Mitigação (Hipótese):** a allowlist de redirect URIs do Spotify recusa um host não cadastrado.
- **Correção:** exigir a variável sempre que `isDevelopmentFlow(env)` for falso, ou registrar a exceção do preview como decisão do dono.

## Informativo

- **I1. `UNLINK_SCRIPT` (`upstash-store.ts:72-75`), lido linha a linha:**
  - **Fato:**
    - Usa 1 KEY declarada (seguro em cluster) e ARGV[1] = driverId já validado (o ponteiro é calculado com `keys.spotifyAccount` antes).
    - `GET` de chave ausente vira `false` em Lua, que nunca é igual a uma string, então devolve 0.
    - Só faz `DEL` se o valor for exatamente o driverId e devolve o inteiro do `DEL`. Nunca apaga a ligação de outro motorista.
    - É atômico, como todo script Lua.
    - Um `WRONGTYPE` no `GET` aborta o script com erro, que vira `DriverStoreUnavailableError`.
    - Conferi no SDK que `set(k, v, {nx|xx})` serializa como `set k v nx|xx` e que `eval` envia `eval script n keys... args...`.
  - **Hipótese (nunca rodou em Redis/Upstash real):**
    - O Upstash REST devolve o inteiro como número JSON e `null` para `SET NX/XX` não aplicado.
    - O fake dos testes (`token-store.test.ts:341-348`) só reconhece o script pela string e emula a semântica. Ele não executa Lua.
- **I2. Enumeração:**
  - A recusa por "conta já ligada" e a recusa da conta do dono devolvem 400 com a mesma página das outras falhas (teste em `tests/acceptance/spotify-custody.test.ts:519`).
  - Para ver essa recusa, é preciso consentir com a conta, ou seja, ter as credenciais dela. O atacante de phishing só vê o próprio `connected` continuar `false`, que é igual a qualquer outra falha.
  - Vazamento desprezível.
- **I3. Página de sucesso:**
  - `escapeHtml` cobre `& < > " '`. O rótulo vai em conteúdo de elemento. A CSP é `default-src 'none'` e a página é `no-store`. Os controles e bidi são removidos (`profile.ts:16`).
  - O rótulo (display_name ou id) só aparece para quem acabou de consentir com aquela conta, uma vez, porque o `state` é de uso único. Não expõe o rótulo do motorista do Finn.
  - O `slice(0,64)` pode cortar um par surrogate, o que é inofensivo.
- **I4. Logs:**
  - `profile.ts` e `connect.ts` não logam nada.
  - Em `auth.ts:177` entrou uma mensagem fixa. `getOwnerSpotifyUserId` lança erro com mensagem fixa, engolida pelo callback.
  - Nenhum token, `state`, `code`, id do Spotify ou rótulo aparece em log (Fato pela leitura; as varreduras de log dos testes passam).
- **I5. Dono:**
  - Não achei caminho para um não dono chegar ao token do servidor. O token do servidor só é usado quando `driverId === LEGACY_OWNER_DRIVER_ID`, e o `driverId` vem da sessão.
  - O access token do dono que a consulta de perfil põe em cache não é devolvido por nenhuma rota.
  - Sem `SPOTIFY_REFRESH_TOKEN`, a checagem do dono é pulada (decisão registrada).
  - Se o RT do dono for inválido, todo connect de convidado dá 502. Isso falha fechado.
- **I6. Limites que continuam:**
  - O cache de access token em outras instâncias dura até cerca de 59 min depois de DELETE ou reconexão. Depois de revoke ou purge feitos pelo CLI, nenhuma instância é avisada.
  - O mapa `epochs` cresce um item por motorista desconectado, o que é desprezível.
  - O consent phishing contra contas que ainda não estão no Finn continua aberto (o callback não é ligado ao navegador). É dívida declarada (`spotify-custody.test.ts:148`). O índice só protege contas já ligadas e a conta do dono.

## Não verificado

- Redis/Upstash real: `SET NX/XX`, `EVAL` do `UNLINK_SCRIPT` e os tipos das respostas.
- Várias instâncias de verdade.
- Se o Spotify rotaciona o refresh token neste fluxo.
- Que caracteres os ids reais do Spotify usam: um id fora de `[A-Za-z0-9._-]{1,100}` dá 502 e o usuário não consegue conectar.
- Lote completo, typecheck, lint e build.
