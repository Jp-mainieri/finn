# Checagem de segurança: expirar o cookie legado `finn_spotify_rt`

- Branch: `fix/expire-legacy-spotify-cookie`, comparada com `feat/pwa-invite-session` (commits `3a9344e`, `af1e279`).
- Escopo: `src/lib/spotify/oauth.ts`, `src/lib/spotify/connect.ts`, `src/app/api/spotify/spotify-routes.test.ts`, mais o que eles tocam: `authorizeDriver`, o cliente `spotify-connection.ts`, `voice-controller.ts`, `public/sw.js`, `next.config.ts` e o histórico do callback antigo.
- Origem: achado M1 de `docs/revisoes/web-pwa-invite-security-review.md`.
- Revisão somente leitura. Nenhum teste foi rodado nesta checagem. Este documento não aprova merge.

## Resumo

| Severidade | Qtde | Itens |
|---|---|---|
| Crítico | 0 | — |
| Alto | 0 | — |
| Médio | 1 | M1: a expiração só ocorre quando o usuário abre Configurações, por host e por contexto |
| Baixo | 2 | B1: o ramo do dono não tem teste do Set-Cookie. B2: nenhum teste envia o cookie e confere que ele não é refletido |

O cabeçalho em si está correto: tem o mesmo nome, o mesmo Path e nenhum Domain, igual ao que o código antigo gravava. Não carrega valor e não depende de entrada do cliente. Só sai em 200 autenticado, e o Secure só some em dev local. Nenhum vetor novo foi encontrado.

## Respostas às perguntas

### 1. O Set-Cookie expira o cookie original?

Sim, no mesmo host.

- **Fato.** O único lugar que gravava o cookie foi o callback introduzido em `7665a07` e removido em `bc7e58c`. O valor gravado era `finn_spotify_rt=${encodeURIComponent(refreshToken)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax[; Secure]` (`bc7e58c^:src/app/api/spotify/callback/route.ts:117-120`).
  - Não havia `Domain`, então o cookie é host-only. Não havia prefixo `__Host-`/`__Secure-`.
  - O Secure dependia do esquema da requisição: `https:` ou `x-forwarded-proto: https` (`:23-26` do mesmo arquivo).
- **Fato.** `git log -S finn_spotify_rt --all` não mostra outro ponto de gravação: nem `document.cookie`, nem outro path, nem outro domain. Os demais commits só citam o nome em testes ou docs.
- **Fato.** O cabeçalho novo é `finn_spotify_rt=; Path=/; Max-Age=0; HttpOnly; [Secure; ]SameSite=Lax`, sem Domain (`src/lib/spotify/oauth.ts:39-41`). Os três campos que identificam o cookie conferem: nome, host-only e `Path=/`. SameSite e HttpOnly não entram na identificação.
- **Fato.** Em produção, o cookie antigo foi gravado com Secure, porque o acesso era HTTPS. O de expiração também leva Secure. Uma resposta HTTPS pode sobrescrever cookie Secure, com ou sem o flag.
- **Fato.** O cliente chama `fetch("/api/spotify/connection")` com caminho relativo, ou seja, mesma origem (`src/lib/voice/spotify-connection.ts:66,79`). O `credentials` padrão é `same-origin`, então o navegador aplica o Set-Cookie da resposta.
- **Limite (ver M1).** Como o cookie é host-only, ele só expira no host que recebe a chamada. Uma cópia gravada em outro host (URL de preview `*.vercel.app` ou domínio anterior) continua lá.

### 2. Algo lê, loga ou reflete o valor recebido?

Não.

- **Fato.** `handleConnectionStatus` e `handleDisconnect` não leem `Cookie` (`src/lib/spotify/connect.ts:177-206`).
  - O único leitor de cookie em `connect.ts` é `cookieValue(request, OAUTH_STATE_COOKIE)` (`:81-84, :95`). Ele é chamado só com o nome do state OAuth e só no fluxo de dev.
- **Fato.** O valor do Set-Cookie é montado só com constantes e com `env` (`oauth.ts:40`). Nada vem da requisição, então não há como injetar cabeçalho nem refletir o valor.
- **Fato.** Não há `console.*` nos caminhos tocados. `git grep finn_spotify_rt -- src` fora dos testes só encontra a constante (`oauth.ts:36`).
- **Fato.** Não existe `middleware.ts`/`proxy.ts`. `next.config.ts` só define cabeçalhos para `/sw.js`.

### 3. Pode vazar para resposta não autenticada ou criar vetor novo?

Não.

- **Respostas não autenticadas.** `connectionOk` só é chamado depois de `authorizeDriver` (`connect.ts:178-179, 193-194`). Respostas 401 e 503 (`connect.ts:187, 198`) não carregam o cookie, e o teste cobre 401 e 503 (`spotify-routes.test.ts:353-358`). O cookie não tem valor, então mesmo um vazamento não exporia nada.
- **Fixation.** Não se aplica. O valor é vazio e a resposta só apaga.
- **CSRF no DELETE.** A autenticação é só por `Authorization: Bearer` (`src/lib/auth.ts:203-209, 225-230`), sem sessão por cookie. Uma página de outra origem não envia esse cabeçalho sem preflight CORS, e o projeto não define cabeçalhos CORS. O diff não muda esse quadro. Mesmo que o DELETE fosse disparado, apagar um cookie morto não causaria dano.
- **Cache.**
  - As respostas mantêm `Cache-Control: no-store` (`connect.ts:27,30`), e o cliente usa `cache: "no-store"`.
  - O service worker não intercepta `/api/*` (`public/sw.js:19`).
  - Uma resposta com Set-Cookie servida de cache compartilhado só poderia apagar, nunca gravar, valor.
- **Dado de outro motorista.** O cookie não tem escopo de motorista e não traz dado de ninguém. Nenhuma chave Redis nova foi criada.

### 4. `isDevelopmentFlow` pode omitir o Secure em produção?

Não, na Vercel.

- **Fato.** A regra é `NODE_ENV === "development" && (!VERCEL_ENV || VERCEL_ENV === "development")` (`oauth.ts:31-33`). Na Vercel, `VERCEL_ENV` vale `production` ou `preview`, então o Secure fica mesmo que alguém defina `NODE_ENV=development`. O teste cobre `development + preview`, `production` e `{}` (`spotify-routes.test.ts:361-366`).
- **Resíduo.** Um host próprio fora da Vercel rodando com `NODE_ENV=development` omitiria o Secure. Pela definição do projeto, isso é dev. Mesmo assim, o impacto é nulo em confidencialidade: o cabeçalho não tem valor.
  - No pior caso, o navegador recusa sobrescrever um cookie Secure vindo de origem HTTP, e o cookie sobrevive. Isso é falha de eficácia, não vazamento.

## Achados

### M1 (médio): a expiração depende de abrir Configurações, em cada host e contexto

- **Fato.** Este é o resíduo do M1 original.
- **Fato.** `GET /api/spotify/connection` só é chamado quando Configurações abre, ou na volta ao app com Configurações aberto (`src/lib/voice/voice-controller.ts:203-206, 304`). `DELETE` só é chamado ao desconectar.
  - O M1 original pedia "uma resposta que todo carregamento alcança" e citava `/api/orchestrator` para o uso normal. O diff cobre só `/connection`.
- **Consequência.** Até o dono abrir Configurações, o refresh token em claro continua indo em toda requisição à origem, inclusive `/api/orchestrator` e `/api/session`. Isso vale para cada contexto separadamente: no iOS, Safari e PWA instalado têm cookies separados. Também vale por host: preview e domínio antigo não são afetados (ver pergunta 1).
- **Correção, a escolher.**
  - (a) Uma ação documentada do dono: abrir Configurações em cada contexto e host onde usou o fluxo antigo.
  - (b) Emitir o mesmo cabeçalho também em uma resposta 200 autenticada que todo carregamento alcança, como `/api/session` ou `/api/orchestrator`.
  - Em qualquer caso, a revogação do app Finn em spotify.com (ação do dono, já no M1 original) continua sendo a única medida que neutraliza as cópias fora de alcance: outros hosts, logs e `localStorage` antigo.

### B1 (baixo): o ramo do dono não tem teste do Set-Cookie

- **Fato.** O código emite o cookie no ramo do dono (`connect.ts:181, 202`), mas o teste usa só o motorista `"A"` (`spotify-routes.test.ts:345-359`).
- **Por que importa.** O aparelho do dono é o principal portador do cookie. Uma regressão nesse ramo passaria sem falhar teste.
- **Correção.** Repetir a asserção com a sessão do dono, em GET e em DELETE.

### B2 (baixo): nenhum teste envia o cookie e confere que ele não é refletido

- **Fato.** O teste novo não manda `Cookie: finn_spotify_rt=<valor>` na requisição (`spotify-routes.test.ts:55-56, 345-359`). A garantia de que o valor não aparece no corpo, nos cabeçalhos ou no log vem só da leitura do código.
- **Correção.** Enviar um valor sentinela e conferir as três coisas:
  - o Set-Cookie é exatamente o de expiração;
  - nem o corpo nem os cabeçalhos contêm o sentinela;
  - o log fica vazio, usando o `loggedText` já existente.

## Não verificado

- Comportamento real dos navegadores ao expirar o cookie (Safari/iOS, PWA instalado e Chrome), incluindo a separação de cookies entre Safari e PWA no iOS. Só o texto do cabeçalho foi lido.
- Se em produção existe hoje algum aparelho com o cookie, e em quais hosts ele foi gravado (produção, preview ou domínio anterior).
- Se a Vercel (logs de requisição ou log drains) registra o cabeçalho `Cookie`.
- O valor efetivo de `NODE_ENV` em `next start` fora da Vercel quando ele é definido como `development`.
- Testes: nada foi rodado nesta checagem. As contagens do relatório `docs/relatorios/api-expire-legacy-cookie-2026-10-28.md` (1139 passaram, 4 ignorados) não foram reproduzidas.
- Respostas 403/429: não existem nesses dois handlers hoje. Se forem adicionadas, não há teste garantindo que venham sem o cookie.
