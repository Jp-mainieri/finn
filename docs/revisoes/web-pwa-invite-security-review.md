# Security review: entrega 5b (PWA com convite e Spotify pelo servidor)

Data: 2026-10-27. Branch `feat/pwa-invite-session`, diff `37cddd0..HEAD` (commits `4794140`, `e25d7df`). Contrato: [`../contratos/pwa-convite-e-dono.md`](../contratos/pwa-convite-e-dono.md). O relatório do implementador ([`../relatorios/web-pwa-invite-2026-10-27.md`](../relatorios/web-pwa-invite-2026-10-27.md)) foi lido como dado, não como prova.

**Esta revisão não aprova merge.** Ela só relata.

## Como foi feito

- Leitura do diff inteiro e do que ele toca: `TokenStore`, `public/sw.js`, `next.config.ts`, `layout.tsx`, as rotas `/api/session` e `/api/spotify/*`, `lib/spotify/connect.ts`, `lib/spotify/oauth.ts`, `lib/auth.ts`, `lib/driver/session-token.ts`, `client-actions.ts`.
- Código antigo conferido no git: callback antigo (`bc7e58c^:src/app/api/spotify/callback/route.ts`), login antigo (`bc7e58c^:src/app/api/spotify/login/route.ts`), `DriverSettingsModal` e `driver-settings` antigos (`37cddd0`). Também `git log -p --all -G "localStorage|STORAGE_KEY|setItem\("` para listar todas as chaves que o cliente já gravou.
- Testes afetados: `npx vitest run src/lib/voice/{invite-client,spotify-connection,legacy-cleanup,no-device-secrets,failure-speech,driver-settings,orchestrator-client,delegation-handler,stt-tts-session}.test.ts`. Resultado: **9 arquivos, 94 testes passaram, 0 falharam.**
- Sonda do validador de URL: `isSpotifyConsentUrl` copiado para um script no scratchpad e rodado com 23 entradas adversas no `URL` WHATWG do Node. Nenhum código da árvore foi alterado.

## Resumo

| Severidade | Qtde | Itens |
|---|---|---|
| Crítico | 0 | — |
| Alto | 0 | — |
| Médio | 2 | M1 cookie `finn_spotify_rt` de 1 ano não expira; M2 "Sair" e "outro convite" não revogam a sessão no servidor |
| Baixo | 9 | B1 a B9 |

Nada desta entrega, sozinho, bloqueia convites em produção. M2 precisa de uma decisão do dono antes de convidar quem divide aparelho. M1 fecha um débito antigo (item 19 do `ESTADO_ATUAL.md`) e não afeta convidados novos.

---

## Achados

### M1 (médio): o cookie `finn_spotify_rt` de 1 ano continua no aparelho e nada o expira

- **Fato.** O callback antigo gravava `finn_spotify_rt=<refresh token>; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax; Secure` (`bc7e58c^:src/app/api/spotify/callback/route.ts:117-120`).
- **Fato.** Hoje nenhuma resposta do servidor expira esse cookie. `git grep finn_spotify_rt HEAD -- src` só encontra testes (`orchestrator/route.test.ts`, `tests/acceptance/driver-isolation.test.ts`), que confirmam que ele é ignorado.
- **Fato.** O cookie é `HttpOnly`, então o PWA não consegue apagá-lo. Esta entrega não mexe nele, e nem poderia: `src/app/api/**` está fora do escopo do `web`.
- **Fato.** Por ser `Path=/`, ele vai em toda requisição à origem, inclusive `/api/orchestrator`, `/api/session` e `/api/spotify/*`.
- **Hipótese.** O valor é um refresh token do Spotify válido até ser revogado na conta Spotify. É provavelmente o do dono, ou o de quem testou o fluxo antigo em produção. Hoje ele vaza se alguém passar a logar headers ou cookies, ou se um log drain da Vercel capturar `Cookie`.
- **Quem é afetado.** Só os aparelhos que passaram pelo callback antigo. Convidados novos nunca o recebem.
- **Correção (para o `api`, não para o `web`).** Enviar `Set-Cookie: finn_spotify_rt=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` numa resposta que todo carregamento alcança. O `GET /api/spotify/connection` é chamado ao abrir Configurações. `/api/orchestrator` cobre o uso normal.
- **Correção (ação do dono).** Revogar o acesso do app Finn em spotify.com, em "Apps". Isso mata todas as cópias de uma vez: cookie, `localStorage` antigo, histórico e logs. Para o dono, depois disso é preciso gerar um novo `SPOTIFY_REFRESH_TOKEN`, e isso coincide com a rotação já recomendada no item 19.

### M2 (médio): "Sair deste aparelho" e "Entrar com outro convite" só agem no aparelho; a sessão continua válida no servidor por até 90 dias

- **Fato.** `signOut()` só chama `this.tokens.clear()` (`src/lib/voice/voice-controller.ts:154-158`). O sucesso de um novo convite só sobrescreve a chave (`invite-client.ts:62`). Nenhuma chamada ao servidor revoga o token anterior.
- **Fato.** Os tokens `v1.` valem `SESSION_TTL_SECONDS = 90 dias` (`src/lib/driver/session-token.ts:5`). Hoje a revogação só existe pelo `driver:rotate`/`revoke` do dono (incrementa `tokenVersion`).
- **Fato.** O contrato pede exatamente isso: "'Sair deste aparelho' apaga o token local". Não é desvio do contrato. É um risco que ainda não foi aceito por escrito.
- **Risco.** Num aparelho compartilhado, ou quando o token já foi copiado (backup, XSS, alguém que usou o aparelho), quem "saiu" acha que encerrou a sessão, mas não encerrou.
- **Correção.**
  1. Decisão do dono: aceitar e documentar ("sair só apaga deste aparelho; para cortar acesso, peça ao dono").
  2. Ou criar `POST /api/session/logout` (escopo `api`), que roda `rotateSessions(driverId)` e corta todos os aparelhos daquele motorista. Nesse caso o PWA chama a rota no "Sair" e na troca de convite, antes de apagar ou sobrescrever o token.

### B1 (baixo): `?spotify_refresh_token=` não é mais retirado da URL

- **Fato.** O `useEffect` antigo do `DriverSettingsModal` fazia `history.replaceState` quando a URL trazia `spotify_refresh_token` ou `spotify_token` (`37cddd0:src/components/DriverSettingsModal.tsx:240-252`). Ele saiu, e a leitura também. Nada mais limpa a URL.
- **Fato.** O callback antigo navegava para `'/?spotify_refresh_token=' + token` (`bc7e58c^:callback/route.ts:109`).
- **Hipótese.** O histórico global do Safari e as sugestões da barra de endereço guardam a URL original mesmo depois do `replaceState`. Reabrir essa entrada hoje deixa o token na barra e no histórico da sessão. Com a política padrão `strict-origin-when-cross-origin`, ele também vai no `Referer` completo das requisições da mesma origem (`/api/*`). Para o Spotify só vai a origem.
- **Correção.** No carregamento, se `location.search` ou `location.hash` contiver `spotify_refresh_token` ou `spotify_token`, fazer `history.replaceState(null, "", location.pathname)` **sem ler o valor**. Considerar também `Referrer-Policy: same-origin` ou `no-referrer` nas páginas do app (`next.config.ts`). A revogação no Spotify (M1) neutraliza qualquer cópia que reste.

### B2 (baixo): o token devolvido por `/api/session` não é validado além de "string não vazia"

- **Fato.** `invite-client.ts:61-62` aceita qualquer string não vazia e grava. Campos extras, `driverId` e `label` são ignorados (correto).
- **Efeitos de uma resposta adulterada.** Isso exige que o servidor ou o TLS da mesma origem estejam comprometidos.
  - Uma string enorme estoura a cota do `localStorage`. O `TokenStore` cai para memória em silêncio.
  - Um token com `\n` ou caractere não Latin-1 faz `fetch` lançar ao montar `Authorization` (**Hipótese** quanto ao caminho exato). O app mostra "indisponível" e não volta à tela de convite.
- **Correção.** Gravar só se `token.length <= 1024 && /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)`. São o mesmo limite e o mesmo formato de `verifySessionToken` (`session-token.ts:66-68`). Fora disso, usar `unavailable`.

### B3 (baixo): corrida entre conectar o Spotify e sair ou trocar de convite

- **Fato.** `connectSpotify()` lê o token antes do POST e navega quando a resposta chega, sem conferir se a sessão ainda é a mesma (`voice-controller.ts:173-177`; `spotify-connection.ts:87-96`). O mesmo vale para `refreshSpotify` e `disconnectSpotify` (`voice-controller.ts:168-182`), que aplicam ao estado novo o resultado de uma requisição feita com o token anterior.
- **Risco.** Num aparelho compartilhado, A toca "Conectar" e logo em seguida "Entrar com outro convite" ou "Sair". O app navega para o consentimento amarrado ao `driverId` de A (o `state` é do servidor). Quem consentir liga a **própria** conta Spotify ao motorista A. Em escala menor, B pode ver "Conectado" de A por um instante.
- **Correção.** Guardar o token do início. Antes de `navigate` e de cada `update({ spotify })`, conferir `this.tokens.get() === tokenNoInício && !this.view.needsToken`. Abortar as requisições em voo (`AbortController`) em `signOut` e `openInvite`.

### B4 (baixo): as legendas do motorista anterior continuam na tela depois de sair ou trocar de convite

- **Fato.** `userText` e `assistantText` só são zerados em `openSession` (`voice-controller.ts:324`). `signOut`, `openInvite` e `afterTokenSaved` não mexem neles (`voice-controller.ts:135-158`), e `TripScreen.tsx:69-80` os mostra.
- **Risco.** O motorista B, ao entrar, vê a última fala e a última resposta de A, que podem conter um endereço ou um nome.
- **Correção.** Zerar `userText`, `assistantText` e `pendingActions` em `signOut` e em `afterTokenSaved`.

### B5 (baixo): o validador da URL de consentimento está correto, mas o app navega com a string crua, e o validador não restringe caminho nem app

- **Fato (sonda com WHATWG URL).** Ele recusa:
  - `http:`, `javascript:`, `data:`, `//accounts…`
  - userinfo (`accounts.spotify.com@evil.com`, `user:pw@…`)
  - subdomínio enganoso (`accounts.spotify.com.evil.com`), ponto final no host, porta não padrão
  - punycode
  - `evil.com\accounts.spotify.com`
- **Fato (sonda com WHATWG URL).** Ele aceita formas não canônicas que **resolvem para o host `accounts.spotify.com`**: caixa alta, `:443`, `https:/\accounts…`, `https:accounts…`, `accounts%2Espotify.com`, espaço inicial, `\n` no meio, `accounts.spotify.com\@evil.com` (vira caminho `/@evil.com`), `#@evil.com`. Nenhuma entrada aceita leva para outro host.
- **Hipótese.** O Safari/WebKit interpreta a string crua passada a `location.assign` do mesmo jeito que o `URL` do Node. Não testei.
- **Fato.** Não há checagem de `pathname` nem de `client_id`. Uma resposta adulterada pode levar ao consentimento de **outro app OAuth** em accounts.spotify.com (phishing de consentimento) ou a outro caminho do Spotify. Isso exige que o servidor ou o TLS estejam comprometidos.
- **Correção.** `navigate(u.href)` com a URL já interpretada. Exigir `u.pathname === "/authorize"`. Opcionalmente conferir `client_id` contra um valor público conhecido.

### B6 (baixo, informativo): o cliente não limita tentativas de convite

- **Fato.** O botão só fica desabilitado enquanto a requisição está em voo (`InviteSetup.tsx:21,73`). Depois de um 429 ele volta na hora.
- **Fato.** O controle real é o servidor: 10 tentativas por 600 s por IP, no Redis e não em memória (`src/lib/driver/invite.ts:58-60`; `upstash-store.ts`, `RATELIMIT_SCRIPT`). Um limite no cliente não é controle de segurança.
- **Hipótese.** Por IP, motoristas atrás do mesmo CGNAT da operadora móvel dividem o balde. Isso já é coberto pelo item 11 e pelo A3.
- **Correção (UX).** Desabilitar o botão até o fim do `Retry-After`.

### B7 (baixo): o checklist manual descreve um comportamento que não existe

- **Fato.** `tests/MANUAL.md:22` diz que um código mal digitado mostra "Confira o código.". Mas o servidor responde 401 ("Convite inválido.") para código malformado: `normalizeInviteCode` dá `null`, depois `redeemInvite` dá `null`, e `route.ts:81` responde 401 (`upstash-store.ts:341-342`). Só corpo vazio ou não string dá 400.
- **Por que importa.** O comportamento do servidor é o certo (não enumera). Um checklist errado pode levar alguém a "corrigir" a rota para um 400 distinto.
- **Correção.** Ajustar o texto do MANUAL: código malformado também mostra "Convite inválido.".

### B8 (baixo): depois da virada, o token legado fica no aparelho até um novo convite ou "Sair"

- **Fato.** `requireToken()` não apaga o token (`voice-controller.ts:449-451`). Com a flag desligada, o `FINN_API_TOKEN` gravado em `finn.apiToken` não abre nada (`auth.ts`, `legacyMatches`), mas continua sendo o valor de uma variável viva na Vercel. Se a flag voltar a `1`, ele revive. Hoje esse valor está no `localStorage` do dono, e talvez de outros aparelhos onde ele foi colado.
- **Correção.**
  1. No roteiro, depois do passo 5, remover ou rotacionar `FINN_API_TOKEN` na Vercel (ação do dono).
  2. Opcional no cliente: num 401 com token sem prefixo `v1.`, apagá-lo.

### B9 (baixo): a guarda estática de logs é por linha

- **Fato.** `no-device-secrets.test.ts:33-38` testa cada linha isoladamente. Um `console.warn(` cujo argumento sensível esteja na linha seguinte passa despercebido. Hoje não existe esse caso: revisei os 16 `console.*` de `src/lib/voice` e `src/components`, e nenhum recebe token, código, `driverId` ou corpo de resposta.
- **Correção.** Aplicar a regex ao texto da chamada inteira (do `console.` até o parêntese que fecha), ou usar uma regra de lint.

---

## Respostas às perguntas do brief

### 1. Token de sessão no aparelho

- **Fato.** Ele fica em `localStorage["finn.apiToken"]` (`config.ts:67`), a mesma chave e o mesmo `TokenStore` do legado, como o contrato pede. O token legado continua indo pelo mesmo canal (`Authorization: Bearer`) para todas as rotas, e o servidor decide.
- **XSS, Fato.**
  - Não há `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `eval`, `new Function` nem `document.write` no cliente. Os `eval` encontrados são o `redis.eval` do servidor, em `upstash-store.ts`.
  - Tudo é renderizado como texto React, então fica escapado.
  - `label` e `driverId` da resposta são descartados (`invite-client.ts:57-62`).
  - As mensagens de erro na tela são constantes do cliente (`INVITE_MESSAGES`, `SPOTIFY_MESSAGES`). Nenhum texto do servidor vira mensagem.
- **XSS, Fato.** Não há CSP nas páginas do app: `next.config.ts` só define cabeçalho para `/sw.js`. Só as páginas `htmlPage` do Spotify têm CSP (`oauth.ts:77-78`). Sem nenhum sink encontrado, isso é defesa em profundidade, não um achado.
- **URL e log, Fato.** O token só vai em header. Nunca vai em URL ou query, nem em `console.*`. Todas as chamadas novas usam `cache: "no-store"`.
- **Service worker, Fato.** `public/sw.js:17-25` só trata `request.mode === "navigate"` (página offline) e não cacheia nada. `/api/*` e `/api/session` passam direto. O `sw.js` é servido com `no-store` (`next.config.ts:7`).
- **Troca de convite, Fato.** O token é sobrescrito só em caso de sucesso. Uma falha mantém o anterior (teste `invite-client.test.ts:124`).
- **"Sair", Fato.** Apaga o token local. Ver M2: não revoga no servidor.

### 2. Fluxo de convite

- **Fato.** O código vive só no estado React e no corpo JSON do `POST`. Ele nunca vai para storage, log ou URL. O campo tem `autoComplete="off"`, `autoCorrect="off"` e `spellCheck={false}`.
- **Fato.** As mensagens não enumeram: 401 dá um texto único, e 400, 413 e 415 dão outro texto único. O corpo do servidor é ignorado.
- **Fato.** No 429, o `Retry-After` é lido como número de segundos e arredondado para cima em minutos. Data HTTP, vazio ou inválido caem num texto fixo. Um valor absurdo produz só um número estranho na tela (cosmético).
- **Fato.** Resposta maliciosa: um 200 sem token, ou com corpo que não é JSON, dá `unavailable` e não grava nada. Ver B2 para token enorme ou mal formado.
- **Força bruta.** Ver B6.

### 3. Conexão do Spotify

- **Fato.** `POST /api/spotify/connect` vai com Bearer. A navegação só ocorre se `isSpotifyConsentUrl` passar, na mesma janela (`location.assign`). Ver B5 para os detalhes da checagem: userinfo, subdomínio, esquema, caixa e barra invertida estão cobertos.
- **Fato.** Um redirect depois de accounts.spotify.com segue a `redirect_uri` cadastrada no Spotify. O cliente não controla isso.
- **Fato.** O 403 vira o estado "owner", sem erro. O `DELETE` que devolve `connected: true` também vira "owner".
- **Fato.** A página de sucesso do callback não tem link de volta. Ela só mostra o `label` escapado, com CSP `default-src 'none'` e `no-referrer` (`connect.ts:148-151`, `oauth.ts:72-80`).
- **Fato.** O `onVisible` só relê o estado com Configurações aberta e token presente (`voice-controller.ts:259`).
- **Hipótese (iOS standalone).** `location.assign` para uma origem fora do escopo abre uma camada de navegador dentro do app ou abre o Safari. Como a produção não amarra o callback a cookie, o fluxo deve terminar em qualquer dos dois. Pode ser que `visibilitychange` não dispare ao fechar essa camada, e então o estado só atualiza ao reabrir Configurações. O MANUAL já pede esse teste.
- **Fato.** O PWA não guarda mais refresh token nem endereço. A guarda estática `no-device-secrets.test.ts` cobre os nomes. `saveDriverSettings` só grava `ttsMode` e `voiceProvider`.
- **Corrida.** Ver B3.

### 4. Limpeza das chaves antigas

- **Fato.** As únicas chaves que o cliente já gravou são `finn.apiToken` e `finn.driverSettings` (busca no histórico inteiro do git).
- **Fato.** Os campos sensíveis que já foram gravados em `finn.driverSettings`:
  - `spotifyRefreshToken`, pelo callback antigo (`bc7e58c^:callback/route.ts:98-100`), pelo modal antigo (via URL) e por `driver-settings` antigo;
  - `casa` e `trabalho`, pelo modal antigo e por `saveDictatedAddress`.
- **Fato.** `purgeLegacyDriverSettings` remove `spotifyRefreshToken`, `casa`, `trabalho` e `savedAddresses` (`legacy-cleanup.ts:6`) a cada carregamento, no construtor do `VoiceController` (`voice-controller.ts:72-79`). Isso cobre tudo o que foi gravado. Além disso, qualquer `saveDriverSettings` posterior regrava só os campos conhecidos.
- **Fato.** Os cookies antigos:
  - `finn_spotify_token` só era lido, nunca gravado;
  - `finn_spotify_mode` (valor `pwa`, `Path=/api/spotify`, vida curta) não é segredo;
  - `finn_spotify_rt`: ver M1.
- **URL e histórico.** Ver B1.
- **Hipótese.** No iOS, o app instalado e o Safari têm `localStorage` e cookies separados. A limpeza só acontece no contexto em que o PWA novo é aberto. Uma cópia num contexto que nunca reabrir o PWA (por exemplo, o Safari onde o callback antigo rodou) permanece até a revogação no Spotify (M1).

### 5. Falas locais de 429 e 503

- **Fato.** Todos os chamadores de `speakLocal` passam constantes:
  - `delegation-handler.ts:64-66` passa `SPEECH.rateLimited` ou `SPEECH.outOfService`, que vêm de `LOCAL_SPEECH`;
  - `stt-tts-session.ts:323` passa `LOCAL_SPEECH[serverFailure]`;
  - `voice-controller.ts:415` passa `LOCAL_SPEECH[result.failure]`.
- **Fato.** O corpo das respostas 429 e 503 nunca é lido nesses caminhos.
- **Fato.** `speakLocal` usa só `speechSynthesis` e não chama `/api/realtime/tts` (`stt-tts-session.ts:414-419`).
- **Fato.** No GPT-Live, 429 e 503 só aparecem como legenda (`voice-controller.ts:391-396`), sem fala. É uma questão de UX, não de segurança.

### 6. O que ainda impede convites em produção

Pendências além desta entrega, conforme `ESTADO_ATUAL.md` e o contrato:

1. **A3:** regra de rate limit no firewall da Vercel e alerta de cota do Upstash. Inclui o callback do Spotify, que não tem rate limit.
2. **M3:** limite por motorista nas rotas de IA.
3. **Pepper de produção legível pelo script** (roteiro, passo 2), necessário para criar o convite do próprio dono.
4. **Roteiro de virada, passos 1 a 5:** merge dos PRs #1 a #8 em ordem; `FINN_OWNER_DRIVER_ID`; prova com a sessão `v1.`; remover `FINN_LEGACY_TOKEN_ENABLED`.
5. **Infraestrutura:** Upstash provisionado e `FINN_TOKEN_ENC_KEY` em produção. Os scripts Lua (redeem, unlink, revoke, rotate, ratelimit) e `SET NX/XX`/`GETDEL` **nunca rodaram em Upstash real** (itens 8 e 19): verificar num preview antes do primeiro convite.
6. **Checklist manual do iOS** (`tests/MANUAL.md`), que nunca rodou. Ele decide a opção (b).
7. **Amarração do callback ao navegador (opção b).** Sem ela, quem tem sessão pode gerar uma URL de consentimento e induzir outra pessoa a consentir. A conta Spotify da vítima fica então ligada ao motorista do atacante, que passa a controlar a reprodução dela. O risco é aceitável com um grupo pequeno de conhecidos. Reavaliar depois do teste no iOS.
8. **B4 (idempotência do resgate):** decisão de produto pendente.
9. **Spotify:** e-mail de cada convidado na lista do app (limite de 25).
10. **Ações de higiene do dono:** rotacionar `SPOTIFY_REFRESH_TOKEN` e revogar o app no Spotify (M1); depois da virada, remover ou rotacionar `FINN_API_TOKEN` (B8).

**Esta entrega bloqueia?** Não. Recomendo resolver antes do primeiro convite, por serem baratos e reduzirem confusão entre motoristas no mesmo aparelho: a decisão sobre M2, B3 e B4. M1 e B1 fecham o item 19 do estado e não afetam convidados novos.

## Não verificado

- Nada foi aberto em navegador nem em iPhone. Ficaram sem teste:
  - `location.assign` em modo standalone, se `visibilitychange` dispara na volta;
  - a separação de storage e cookies entre o app instalado e o Safari;
  - o histórico global do Safari guardando `?spotify_refresh_token=`;
  - o `Referer` real;
  - se a Vercel registra a query string ou cookies nos logs.
- A interpretação de URL pelo Safari/WebKit não foi testada. A sonda usou o `URL` do Node.
- O lote completo (`npm test && npm run typecheck && npm run lint && npm run build`) não rodou. Rodaram só os 9 arquivos de teste afetados.
- Os componentes `.tsx` e o `VoiceController` não têm teste. B3 e B4 vêm de leitura de código, não de execução.
- Nenhuma chamada a servidor real, Vercel, Upstash ou Spotify.
- O lado do servidor da 5a não foi revisado de novo. Só li o que o diff do cliente toca.
- Arquivos `.env*` não foram lidos.
