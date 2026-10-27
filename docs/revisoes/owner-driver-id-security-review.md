# Security review: entrega 5a (dono registrado, `feat/owner-driver-id`)

Escopo: `git diff 410c0ae..HEAD` (commits 6aaddd7, c0e1d49) e o que ele toca. Contrato: `docs/contratos/pwa-convite-e-dono.md` (Invariantes e 5a). Relatório do implementador lido como dado, não como prova.
Data: 2026-10-27. Revisor: security-review. **Este relatório não aprova merge.**

Comando rodado: `npx vitest run src/lib/owner.test.ts src/lib/auth.test.ts src/lib/a2a-guard.test.ts src/app/api/orchestrator/route.test.ts tests/acceptance/spotify-custody.test.ts tests/acceptance/driver-isolation.test.ts src/app/api/spotify/spotify-routes.test.ts`: 7 arquivos, 224 testes passaram, 0 falharam. Lote completo não rodado aqui. Checagem com `node` em processo isolado: a regex de `isValidDriverId` recusa `\n` no fim, espaço antes e depois; um id gerado por `generateDriverId` tem 22 caracteres e o último sempre está em {A, Q, g, w}.

## Resumo

| Sev. | Id | Achado |
|---|---|---|
| Crítico | n/a | nenhum |
| Alto | n/a | nenhum |
| Médio | M1 | O token legado e o A2A agem como o dono **registrado** sem consultar o status dele: `driver:revoke`/`driver:rotate` do dono não cortam nenhum dos dois |
| Médio | M2 | `FINN_OWNER_DRIVER_ID` é um novo ponto de confiança e só o formato é validado. Um id errado (ex.: o de um convidado) entrega a esse convidado `SPOTIFY_REFRESH_TOKEN` e `WAZE_SAVED_ADDRESSES` |
| Baixo | B1 | A virada pode cair, sem aviso, no estado "sem dono" (variável com espaço ou quebra de linha, ou não aplicada), que só aparece numa linha de log |
| Baixo | B2 | `driver:revoke`/`driver:purge` do dono não avisam que o alvo é o dono; seus efeitos no carro não estão documentados |
| Baixo | B3 | O livro de endereços do id legado fica órfão no Redis, em texto claro, sem caminho de purge |
| Baixo | B4 | Um refresh em voo durante uma troca de dono no mesmo processo pode entregar o token da conta do servidor a quem deixou de ser dono |
| Baixo | B5 | `getOwnerSpotifyUserId(env)` usa `env`, mas `refreshFor` usa `process.env` (encanamento inconsistente) |
| Info | I1 | Vazamento do id do dono: o id não é credencial; não existe caminho que aceite id do cliente |
| Info | I2 | Colisão de id: impossível para o id legado e desprezível (2^-128) para o id real; o `REDEEM_SCRIPT` sobrescreveria sem NX (já existia antes do diff) |
| Info | I3 | O PWA atual continua mandando `driverContext.spotifyRefreshToken` no corpo até a 5b; o servidor ignora |

## O que está fechado (Fato, por leitura e pelos testes acima)

1. **Comparação exata.** `isOwner` (`src/lib/auth.ts:168-172`) recusa o que não é string e compara com `===`, sem trim e sem caixa. Sem dono, devolve sempre falso. `getOwnerDriverId` (`auth.ts:155-165`) aceita a variável só se ela casar exatamente com `^drv_[A-Za-z0-9_-]{22}$`. Valor inválido conta como ausente. A comparação de id não é de segredo, então tempo constante não se aplica. O token legado continua comparado por `digestEquals` (`auth.ts:14-16,188-194`).
2. **Nenhum não dono alcança os recursos do dono.** `SPOTIFY_REFRESH_TOKEN` só é lido em `refreshFor` quando `isOwnerDriver(driverId)` é verdadeiro (`src/lib/spotify/auth.ts:157-161`). `getOwnerSpotifyUserId` falha fechado sem dono (`spotify/auth.ts:251-255`). `WAZE_SAVED_ADDRESSES` só é lido por `SeededAddressBook` quando `isOwner` é verdadeiro (`src/lib/waze/address-book.ts:171-177`). O A2A só roda com dono (`auth.ts:78,106`; `a2a-server.ts:44-45,81`). Não sobrou nenhum uso de `LEGACY_OWNER_DRIVER_ID` como "dono" fora de `getOwnerDriverId` (grep em `src`).
3. **Id legado com a flag desligada.** Mesmo com a variável definida, o id legado não é dono, e o token legado não abre nada (`auth.ts:164,190`).
4. **A2A.** O 503 sem dono sai antes de qualquer acesso ao Redis (`auth.ts:105-106`, antes de `peekRateLimit` em `:118`). O limitador, o formato hex64 e a rotação `FINN_A2A_TOKEN_NEXT` não mudaram no diff. Em `a2a-server.ts:44-45` há uma segunda trava. O id vem de `getOwnerDriverId()`, nunca do corpo.
5. **`driverContext` fora.** A rota lê só `transcript`, `contextId` e `continuation` (`src/app/api/orchestrator/route.ts:22-36`). `AgentTaskInput` não tem mais o campo, e `orchestrate` não o repassa (`src/orchestrator/orchestrate.ts:60`). `save_address` não é mais emitido (`src/agents/waze/tools.ts`, `src/lib/agent-runtime.ts`). Nenhum código de servidor fora dos testes lê `driverContext`.
6. **Logs novos.** Há um só: `"[auth] FINN_OWNER_DRIVER_ID is invalid; ignored"`, uma vez por processo e sem valor (`auth.ts:159-162`). A linha do A2A mudou de texto e segue sem valor (`auth.ts:24`). Nenhum log imprime id, token ou endereço.
7. **Regressões das entregas 3 e 4.** O dono continua recebendo: 403 em `/connect` (`src/lib/spotify/connect.ts:36`); recusa no callback (`connect.ts:126`); recusa em `saveSpotifyRefreshToken` e `saveRotatedSpotifyRefreshToken` (`src/lib/spotify/token-vault.ts:51,73`); `connected` pelo token do servidor (`connect.ts:178`); o DELETE que limpa blob residual (`connect.ts:191-200`); e a recusa da conta Spotify do dono em `/v1/me` (`connect.ts:136-137`). Tudo isso vale por sessão e pelo token legado, e há testes em `src/lib/owner.test.ts:225-272`.
8. **Cache de access token.** A entrada guarda de que tipo veio (`owner`) e é descartada se o tipo mudou (`spotify/auth.ts:209-215`). `ownerSpotifyUserId` só é servido depois de conferir que existe dono (`spotify/auth.ts:254-256`).

---

## M1. O token legado e o A2A agem como o dono registrado sem consultar o status dele (médio)

**Fato (leitura).** Com a flag ligada, `authorizeDriver` devolve `{ driverId: getOwnerDriverId() }` só por comparar o segredo, sem ler o registro (`src/lib/auth.ts:210-215`). O A2A também roda como `getOwnerDriverId()` sem ler o registro (`auth.ts:101-130`, `src/lib/a2a-server.ts:44,81`). Antes do diff, os dois rodavam como um id sem registro: não havia o que revogar e ninguém esperava que houvesse. Agora o dono é um motorista de verdade, com `status` e `tokenVersion`, e as ferramentas de revogação existem:
- `driver:revoke <id do dono>` mata as sessões `v1.` do dono, mas o token legado (enquanto a flag estiver ligada) e o A2A continuam operando como esse id. Isso inclui o Spotify do servidor, a semente de endereços e a escrita no livro `driver-addr:<id real>`.
- `driver:rotate` do dono também não alcança o token legado.

**Fato (leitura).** O que o token legado passa a alcançar além do que já alcançava:
- o livro de endereços do dono real, que o PWA novo grava por voz;
- `GET /api/session`, que agora devolve o id real e o `label` do dono (`src/app/api/session/route.ts:90-96`);
- `DELETE /api/spotify/connection`, que apaga o blob residual e o vínculo de conta do id real.

Quanto aos poderes sobre o Spotify do carro, nada muda: o token legado já os tinha.

**Hipótese.** Num cenário de aparelho perdido ou de token legado vazado na janela entre o passo 4 e o passo 5 do roteiro, o dono roda `driver:revoke` achando que isso corta tudo, mas o token legado continua valendo. O segredo é compartilhado, não expira, e cópias antigas do PWA o guardam.

**Correção sugerida (uma das duas):**
- (a) No caminho legado, quando `FINN_OWNER_DRIVER_ID` estiver definida, exigir `store.getDriver(owner)?.status === "active"`, com falha fechada (503) se o Redis cair. Fazer o mesmo no A2A, depois do Bearer.
- (b) Documentar no roteiro e no `driver:revoke` que revogar o dono não corta o token legado nem o A2A, e que o corte de emergência é remover `FINN_LEGACY_TOKEN_ENABLED` e `FINN_A2A_TOKEN` e reimplantar.

Em qualquer dos casos, encurtar a janela entre os passos 4 e 5.

**Não verificado:** PoC executado. A conclusão vem só da leitura de `auth.ts` e `a2a-server.ts`; não há teste que cubra "dono revogado + token legado".

## M2. `FINN_OWNER_DRIVER_ID` é um novo ponto de confiança, validado só por formato (médio)

**Fato (leitura).** `getOwnerDriverId` aceita qualquer valor no formato certo (`auth.ts:157-158`). Não confere se o motorista existe, se está ativo nem se é a pessoa certa. `driver:list` imprime `driverId`, `label`, `status` e data, sem nenhuma marca de dono (`scripts/lib/admin-cli.mjs:191-196`), e é desse comando que o roteiro (passo 3) manda copiar o id.

**Fato (consequência).** Se o id configurado for o de um convidado:
- esse convidado passa a usar `SPOTIFY_REFRESH_TOKEN` (`spotify/auth.ts:157-160`) e ouve os endereços da semente (`address-book.ts:177`);
- `/connect` dele recebe 403, então ele não consegue nem notar o erro pelo PWA;
- o token legado e o A2A passam a gravar no livro desse convidado.

É a mesma exposição da C1 de `driver-session-routes-security-review.md`, agora por configuração. Se o id não existir no ambiente (digitação errada que mantém o formato, ou um id de preview colado em produção), o efeito é diferente: ninguém usa o servidor por sessão, mas o token legado e o A2A continuam usando, como um id fantasma.

**Hipótese.** O roteiro só cria convites de terceiros depois do passo 5, o que reduz a chance. Mas pode haver motoristas de teste ou de smoke em produção, e não verifiquei se há. Também não verifiquei se a variável será criada só em Production.

**Sobre o atacante que registra, por convite legítimo, um id igual ao do dono.** Fato: o id é gerado no servidor (`src/lib/driver/invite.ts:21-23`, `upstash-store.ts:343`), e o cliente não escolhe nada. Ver I2. Não é caminho prático.

**Correção sugerida:**
- (a) Fazer `driver:list` aceitar `--owner-id` (ou ler `FINN_OWNER_DRIVER_ID` do `--env-file`) e marcar a linha "(dono)", avisando se o id não existe ou está revogado.
- (b) No roteiro, entre os passos 4 e 5, provar que a sessão nova do PWA **é** o dono: `POST /api/spotify/connect` com essa sessão deve dar 403, e `GET /api/spotify/connection` deve dar `connected: true` sem blob. Isso tem de ser checado com a sessão `v1.`, não com o token legado, porque o legado mapeia para qualquer valor válido.
- (c) Opcional: validar no servidor, uma vez por processo, que o dono existe e está ativo. Se não estiver, logar sem valor.

**Não verificado:** o conteúdo atual do Redis de produção; a configuração de escopo da variável na Vercel.

## B1. A virada pode cair, sem aviso, no estado "sem dono" (baixo)

**Fato.** O valor da variável é usado sem trim. Espaço ou quebra de linha no fim o tornam inválido, ele conta como ausente, e o único sinal é uma linha de log por processo (`auth.ts:157-164`; checagem com `node` acima). Com a flag ligada, o sistema cai silenciosamente no id legado, então o token legado continua funcionando e mascara o problema. Depois do passo 5 (flag removida), ninguém é dono:
- o Spotify do carro responde "Conecte seu Spotify";
- o A2A dá 503;
- o callback de convidados troca o `code` com o Spotify e só então falha com 502, porque `getOwnerSpotifyUserId` lança erro quando `SPOTIFY_REFRESH_TOKEN` existe e não há dono (`connect.ts:131-137`, `spotify/auth.ts:251-255`).

O comportamento é de **falha fechada** (Fato): nenhum convidado alcança o token do servidor, e a conta do dono não é ligada a ninguém. O problema é de disponibilidade e de diagnóstico.

**Hipótese.** O passo 4 ("confirmar no carro") só detecta o erro se o carro estiver usando a sessão nova, e não o token legado.

**Correção sugerida:**
- Usar a prova do M2 (b) como porta obrigatória antes do passo 5.
- Opcional: recusar `POST /api/spotify/connect` de convidados com 503 quando `SPOTIFY_REFRESH_TOKEN` existir e não houver dono, para que ninguém faça o consentimento à toa. A mesma condição que hoje só vale no callback passaria a valer antes de emitir o state.

**Não verificado:** como a Vercel trata espaços e quebras de linha no valor colado.

## B2. `driver:revoke` e `driver:purge` do dono não avisam que o alvo é o dono (baixo)

**Fato (leitura)** do que cada comando faz no id real do dono:
- **`driver:purge`** (`upstash-store.ts:306-314`) apaga `spotify-token:<id>` (blob residual, se houver), `driver-addr:<id>` (os endereços ditados pelo dono, que voltam a ser os da semente) e o vínculo de conta. Não mexe em `SPOTIFY_REFRESH_TOKEN`, em `ownerRotatedRefreshToken` nem no cache de access token: o Spotify do carro continua funcionando.
- **`driver:revoke`** marca o motorista como `revoked` e apaga o blob. As sessões do dono passam a receber 401, e o PWA do carro volta à tela de convite. A variável continua apontando para o id revogado, e o token legado (com a flag ligada) e o A2A continuam como dono (ver M1). Para recuperar, é preciso um convite novo, que gera um id novo, depois trocar a variável e reimplantar.

O CLI mostra o alvo e pede confirmação (`admin-cli.mjs:207,224-231`), mas não sabe qual id é o do dono.

**Correção sugerida:** a mesma marca "(dono)" de M2 (a), com um aviso explícito antes de revogar ou purgar o dono. Documentar o efeito no carro em `docs/` e no `--help`.

## B3. Livro de endereços do id legado órfão (baixo)

**Fato.** Os endereços ditados antes da virada estão em `driver-addr:drv_legacy_owner_000000000`. Depois do passo 4, o dono passa a ler `driver-addr:<id real>`, e a semente cobre o que faltar. A chave legada continua no Redis, em texto claro (risco aceito de endereço em claro). Depois do passo 5, ninguém a lê. `driver:purge` não alcança essa chave, porque `getDriver(legado)` devolve `null` e o comando para em "Motorista não encontrado" (`admin-cli.mjs:202-205`).

**Correção sugerida:** acrescentar ao roteiro um passo do dono para apagar (ou copiar e depois apagar) essa chave, ou permitir `driver:purge --legacy-owner`.

**Não verificado:** se a chave existe em produção.

## B4. Refresh em voo atravessando uma troca de dono no mesmo processo (baixo, Hipótese)

**Fato (leitura).** Em `spotify/auth.ts:217-226`, um chamador sem entrada em cache reaproveita o `pendingRefresh` do mesmo `driverId` sem saber de que tipo esse refresh é. Se o refresh começou como dono e, no meio dele, o id deixou de ser dono, o promise devolve o access token da conta do servidor. Isso também vale para quem já estava esperando. O descarte por tipo só acontece na leitura do cache.

**Hipótese.** Na Vercel, mudar uma variável exige reimplantar, e instâncias novas não herdam o processo. O cenário só existe em dev e nos testes. O implementador já registrou isso como "não verificado".

**Correção sugerida:** guardar o tipo junto com o promise (`Map<driverId, { p, owner }>`) e não reaproveitar um promise de tipo diferente.

## B5. `env` inconsistente entre `getOwnerSpotifyUserId` e `refreshFor` (baixo)

**Fato.** `getOwnerSpotifyUserId(env)` decide quem é o dono por `env` (`spotify/auth.ts:254`), mas `getAccessToken` decide por `process.env` (`spotify/auth.ts:157,210`). O mesmo vale para `connect.ts`, que recebe `deps.env`. Em produção, `env === process.env`, então o efeito real hoje é nulo. Num teste ou chamador que injete um `env` diferente, o "dono" de um `env` seria tratado como convidado pelo outro. Isso falha fechado (vai ao cofre), mas pode mascarar regressões.

**Correção sugerida:** passar `env` até `getAccessToken` e `refreshFor`, ou parar de aceitar `env` nessas funções de dono.

## I1. Vazamento do id do dono (informativo)

**Fato.** Nenhuma rota aceita um `driverId` vindo do cliente. A identidade vem só do token `v1.` assinado e conferido no store (`auth.ts:217-221`), do token legado, ou do state OAuth gravado no servidor (`connect.ts:118`). `continuation` nunca carrega identidade, e o corpo do orquestrador é ignorado fora dos 3 campos. Saber o id do dono não concede nada.

O id aparece em: `driver:list` (stdout local); `POST /api/session` (só para o próprio dono, no resgate); e, novidade deste diff, `GET /api/session` com o token legado, que agora devolve o id real e o `label`. Nenhum log imprime o id.

**Sugestão:** manter o id fora de logs e de issues. Não precisa ser tratado como segredo.

## I2. Colisão de id (informativo)

**Fato.** `generateDriverId` usa 128 bits aleatórios, então o último caractere só pode ser A, Q, g ou w. O id legado termina em `0` e **não pode ser gerado**. Colidir com o id real do dono tem probabilidade de cerca de 2^-128 por resgate: não é caminho prático.

Já era assim antes do diff, mas fica registrado: o `REDEEM_SCRIPT` grava o registro com `HSET` sem checar existência (`upstash-store.ts:51`). Numa colisão, ele sobrescreveria `status` e `tokenVersion` do registro existente (reativaria um dono revogado).

**Sugestão (endurecimento barato):** `EXISTS KEYS[2]` antes do `HSET`, devolvendo `{0}` se o id já existir.

## I3. O PWA atual ainda envia o refresh token no corpo (informativo)

**Fato.** `src/lib/voice/orchestrator-client.ts:64-66` continua mandando `driverContext` com `spotifyRefreshToken`. O servidor ignora e não loga o corpo (`route.ts:22-36`). A remoção é da 5b, e o risco fica no aparelho (`localStorage`) e no trânsito, mesmo com TLS.

---

## Respostas diretas às perguntas do brief

1. **Quem é dono.** Fechado (Fato), com a ressalva de que a variável é um ponto de confiança validado só por formato (M2). Espaço, caixa ou quebra de linha no valor: a variável é tratada como ausente ou, no caso da caixa, como um id diferente. Isso falha fechado, mas sem aviso (B1). O registro de um id coincidente não é viável (I2). O vazamento do id não concede nada (I1).
2. **Token legado mapeado para o dono real.** O token alcança a mesma conta Spotify de antes e, a mais: o livro de endereços real do dono, o id real e o `label` em `GET /api/session`, e o DELETE do blob residual e do vínculo de conta. A mudança de risco relevante é que agora existe revogação para o dono, e o token legado passa por cima dela (M1). Na virada, a ordem do contrato (variável antes de remover a flag) está correta. A prova de que a sessão nova é o dono precisa ser feita com a sessão, não com o token legado (M2 b, B1).
3. **A2A.** Roda como dono; o 503 sem dono sai antes do Redis; o limitador e a rotação não mudaram (Fato). Também não consulta o status do dono (M1).
4. **Caches e refresh em voo.** O cache de access token é seguro na leitura. O refresh em voo tem a janela de B4, que só existe com mudança de ambiente em runtime. `ownerSpotifyUserId` e `ownerRotatedRefreshToken` são da conta do servidor, não do id, e a checagem de dono vem antes do cache (Fato).
5. **`driverContext`.** Nada do cliente alcança os agentes além de `transcript`, `contextId` e `continuation` (Fato).
6. **Logs.** Uma linha nova por processo, sem valor (Fato).
7. **Entregas 3 e 4.** Sem regressão encontrada (Fato, com testes passando). Sobre purge e revoke do dono, ver B2: o Spotify do carro sobrevive ao purge; com o revoke, o carro perde as sessões, mas o token legado e o A2A seguem.
8. **`getOwnerSpotifyUserId` sem dono e com token.** Falha fechada (Fato): o connect de convidados termina em 502 depois do consentimento. O roteiro cai nesse estado se a variável estiver inválida ou não tiver sido aplicada quando a flag for removida (B1).

## Não verificado

- O lote completo (`npm test && npm run typecheck && npm run lint && npm run build`): rodei só os 7 arquivos listados acima.
- Os PoCs de M1 e B4: as conclusões vêm de leitura do código; não escrevi teste novo, porque não posso editar a árvore.
- Qualquer coisa na Vercel, no Upstash ou no Spotify reais: escopo da variável, tratamento de espaços no valor, motoristas existentes em produção, existência da chave legada de endereços.
- `.env*` não foi lido.
- Os arquivos do diff em `src/agents/*` e em `tests/*` foram revisados só no que tocam `driverContext` e o dono.
