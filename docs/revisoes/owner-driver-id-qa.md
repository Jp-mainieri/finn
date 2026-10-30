# QA — entrega 5a (dono registrado)

Branch `feat/owner-driver-id` (6aaddd7, c0e1d49). Revisor: agente `qa` (Sonnet, esforço alto), 2026-10-27. Registrado pelo orquestrador a partir do relatório do agente (que não pôde gravar `.md`): resumo fiel, não o texto integral.

## Veredito

Nenhum bloqueante. Em nenhum estado da tabela (31 linhas) um não dono virou dono, e em nenhum o dono perdeu o Spotify na virada, desde que a variável seja válida. 5 não bloqueantes (operação e roteiro). 26 mutações executadas: sobreviventes da suíte do implementador, S1, C2 e V2 (defesa em profundidade), passam a ser mortos pelos testes do qa; A7 é equivalente (ramo inalcançável).

## Não bloqueantes

| # | Achado | Tratamento |
|---|---|---|
| N1 | Variável com sujeira (newline, espaço, aspas) vira "inválida"; com a flag ligada volta ao id legado em silêncio; com a flag removida, ninguém é dono (A2A 503, sessão do dono vira convidado, `GET /callback` 502 depois do consentimento; `connect` continua 200). Recuperável. | Corrigir: `.trim()` do valor da variável; roteiro cria com `printf %s`, confirma com a sessão nova (nunca o token legado) antes de remover a flag e confere o log. |
| N2 | Endereços ditados sob o id legado ficam órfãos na virada: o dono real lê `driver-addr:<id real>`; `casa` volta à semente, `trabalho` some; o hash antigo fica sob um id sem registro (o `driver:purge` não o alcança). | Aceito e documentado no roteiro (o dono dita de novo uma vez; limpeza manual do hash antigo). |
| N3 | O dono não é amarrado ao registro: id válido de outro convidado vira dono por erro de operador; revogar ou rotacionar o dono não corta o token legado nem o A2A. | Corrigir: `driver:list` marca o dono; token legado e A2A exigem o dono ativo quando ele tem registro; roteiro prova com a sessão `v1.`. |
| N4 | `FINN_OWNER_DRIVER_ID` igual ao id legado, com a flag desligada, torna o legado dono e liga o A2A. Não explorável (ninguém autentica com esse id). | Corrigir: o id legado é inválido como valor da variável. |
| N5 | Com a flag desligada e sem a variável, o A2A passa a responder 503 (antes rodava como id legado). | Sem ação: o A2A já está desligado (sem `FINN_A2A_TOKEN`). |

Menores: refresh em voo na troca de dono (só com mudança de env em runtime, não ocorre na Vercel; aceito); `authorizeDriver` ramo inalcançável (equivalente); `getOwnerSpotifyUserId(env)` vs `process.env` em `refreshFor` (só em teste; débito); `tests/helpers/owner.ts` grava `process.env` no import (frágil, mas falha alto).

## Testes

`npx vitest run` nos 18 arquivos do diff: 431 passaram, 0 falharam. `tests/qa`: 65 passaram. Lote afetado + `tests/qa`: 496 passaram. `tsc --noEmit` e `eslint tests/qa` limpos.

## Não verificado

Vercel, Upstash e Spotify reais; se a Vercel preserva newline ao criar a variável; `purgeDriverData` do Upstash apagando o hash de endereços do dono (o `MemoryDriverStore` não modela); estado da flag em produção e uso do A2A; cache `ownerSpotifyUserId` nunca invalidado se `SPOTIFY_REFRESH_TOKEN` mudar (pré-existente); multi-instância; lote completo e build (não pedidos ao qa).

## Desvio de processo

O qa aplicou as mutações na árvore de trabalho enquanto o security-review lia o código em paralelo (janela de segundos por mutação; árvore verificada limpa depois). Daqui em diante, mutações só numa cópia fora do repositório.
