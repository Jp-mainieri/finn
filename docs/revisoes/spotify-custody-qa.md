# QA — entrega 4 (custódia do refresh token do Spotify)

Branch `feat/spotify-token-custody` (da5ed4f, bc7e58c, 136f248). Revisor: agente `qa` (Sonnet, esforço alto), 2026-10-27. Registrado pelo orquestrador a partir do relatório do agente (que não pôde gravar `.md`): resumo fiel, não o texto integral.

## Veredito

Nenhum defeito de produto que bloqueie o merge. 1 bloqueante de **cobertura** (B1) e 11 não bloqueantes. 62 mutações executadas numa cópia fora do repositório: 56 mortas, 6 sobreviventes (2 equivalentes).

## Bloqueante

**B1. A varredura de log não detecta `Error` em `console.*`.** O helper `logged()` de `spotify-routes.test.ts` usa `JSON.stringify` sobre as chamadas, e `JSON.stringify(new Error("x"))` dá `{}`. Mutantes que reintroduzem `err` em `auth.ts`/`api.ts`, logam o refresh token no aviso de rotação ou no endpoint de token sobreviveram à suíte do implementador (M15a a M15d, M38). O código de hoje está correto; falta a proteção contra regressão. Correção: adotar os testes "QA log sweep on the refresh paths and reconnect" e "a Spotify Web API call that fails at the network level" de `tests/qa/spotify-custody.qa.test.ts`, com o helper `flat()` que expande message, stack e cause.

## Não bloqueantes

| # | Achado | Tratamento |
|---|---|---|
| N1 | Desconexão ou revogação durante um refresh em andamento é desfeita (o refresh regrava o blob e o cache). | Corrigir: regravar o blob rotacionado só se ele ainda existir (`SET ... XX`). |
| N2 | `evict` durante refresh em andamento abre refresh paralelo (o `finally` da promessa antiga apaga a entrada da nova). | Corrigir: só apagar se a entrada for a mesma promessa. |
| N3 | State emitido antes de `driver:revoke`/`driver:purge` ainda completa e grava blob; `driver:purge` não alcança o id legado do dono. | Corrigir: callback confere que o motorista existe e está ativo (ou é o id legado, que é recusado, ver N5). |
| N4 | O callback não é amarrado ao navegador que iniciou o fluxo (consent phishing). | **Decisão do dono** (junto do M1 do security-review). |
| N5 | Estado inconsistente do dono: `GET /connection` falso, `connect` grava blob ignorado, 503 sem chave. | Corrigir: `connected` do dono = `Boolean(SPOTIFY_REFRESH_TOKEN)` sem passar pelo vault; `connect` e `saveSpotifyRefreshToken` recusam o id legado (403 na rota); `DELETE` do dono continua funcionando. |
| N6 | Gate de desenvolvimento é só `NODE_ENV === "development"` (com `vercel dev` e variáveis de produção, o token apareceria). | Corrigir: exigir também `VERCEL_ENV` ausente ou `development`. |
| N7 | Refresh compartilhado: o `AbortSignal` do primeiro chamador rejeita os demais. | Pré-existente; aceito. |
| N8 | Redis lento: sem cache negativo, cada requisição tenta de novo (até 2 s). Dono imune. | Aceito (débito). |
| N9 | Callback sem rate limit e sem timeout no `exchangeAuthorizationCode`. | Timeout: corrigir. Rate limit: A3 (firewall, ação do dono). |
| N10 | Rollback por blob antigo válido (inerente ao GCM; exige escrita no Redis). | Informativo. |
| N11 | Lacunas menores: base64url canônico só morto pelo teste do qa; login em development sem teste; tamanhos de `iv`/`tag` equivalentes. | Corrigir via adoção dos testes do qa. |

## Decisão testada: dono com `connected:true` e 403 no `connect`

Aprovada com as ressalvas do qa: usar `Boolean(SPOTIFY_REFRESH_TOKEN)` (não literal `true`); 403 só para `LEGACY_OWNER_DRIVER_ID` (o dono que entrar por convite tem id comum e precisa do fluxo normal); bloquear também em `saveSpotifyRefreshToken` (states já emitidos); não bloquear o `DELETE` do id legado (único caminho de limpeza, pois `driver:purge` recusa id sem registro).

## Testes

`npx vitest run` (31 arquivos afetados + `tests/qa`): 564 passaram, 0 falharam (520 sem os 44 do qa). `tsc --noEmit` e `eslint tests/qa` limpos. Os testes "FINDING" de `tests/qa/spotify-custody.qa.test.ts` fixam o comportamento atual e devem ser invertidos ou apagados quando o achado for corrigido.

## Não verificado

Upstash, Vercel e Spotify reais; abort real de 2 s do SDK; `next dev` com `MemoryDriverStore` (instâncias separadas entre `connect` e `callback`); corrida entre instâncias serverless; smoke em preview e PWA real; se `SPOTIFY_REFRESH_TOKEN` existe em preview e produção; lote completo e build (não pedidos ao qa).
