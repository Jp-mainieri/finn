# QA — entrega 3 (isolamento por motorista)

Branch `feat/driver-isolation` (87e041c, 750de0c, 4f8fdb9). Revisor: agente `qa` (Sonnet, esforço alto), 2026-10-27. Registrado pelo orquestrador a partir do relatório do agente, que não pôde gravar `.md`. O texto abaixo é um resumo fiel, não o relatório integral.

## Veredito

Nenhum furo explorável no isolamento. 1 bloqueante de **cobertura** e 12 não bloqueantes.

## Bloqueante

**B1.** Nenhum teste do implementador falha se `whoIs()` em `src/agents/spotify/tools.ts` passar a devolver o `driverId` do dono fixo (mutante M2: 630 testes continuam verdes). Os testes de `isolation.test.ts` chamam `getAccessToken` com o `driverId` já escolhido, e o teste de rota mocka os agentes. Ninguém liga rota, agente e token. Os testes `tests/qa/driver-isolation-qa.test.ts:75` e `:103` pegam o mutante. Correção: adotar esses dois (ou equivalente em `src/agents/spotify/`).

## Não bloqueantes

| # | Achado | Tratamento |
|---|---|---|
| N1 | Rajada de 50 palpites paralelos passa pelo limitador (peek e increment não atômicos). Comentário de `guardA2A` ("segredo certo nunca é limitado") contradiz o código. | Corrigir o comentário e a doc; atomicidade vira débito (segredo de 256 bits, A2A desligado). |
| N2 | Requisição anônima gasta 1 GET (e 1 EVAL se errada) de Redis. | Corrigir: Bearer fora do formato 64 hex = 401 sem tocar o Redis. |
| N3 | Produção sem `KV_*` derruba até navegação com destino explícito (livro criado na entrada). | Corrigir: criar o livro só quando houver rótulo. |
| N4 | Endereço com surrogate solto passa e envenena o rótulo (`URIError` em toda navegação, sem rota de purga). | Corrigir: rejeitar com `isWellFormed()`. |
| N5 | `normalizeAddress` aceita U+2028/2029, bidi override, zero-width. | Corrigir: rejeitar. |
| N6 | `FINN_A2A_TOKEN_NEXT` igual ao principal em outra caixa é aceito. | Corrigir: comparar em minúsculas. |
| N7 | Teste "A2A ignora driverId" não exercita o `message.driverId` (a chave `params:` sobrescreve). | Corrigir o teste. |
| N8 | Mutantes equivalentes sobrevivem (defesa em profundidade sem teste). | Aceito. |
| N9 | Cliente A2A externo não continua o "waze pergunta o endereço" (artifact sem `continuation`). | Aceito e documentado; A2A só do dono e desligado. |
| N10 | Pré-existente: corpo JSON `null` e cookie com `%` inválido lançam exceção depois da autenticação. | Corrigir (a rota já foi editada nesta entrega). |
| N11 | `Retry-After` sempre 600; balde `noip` compartilhado fora da Vercel. | Aceito (débito). |
| N12 | Redis lento pode somar até ~6 s contra o orçamento de 8 s do agente; `set` pode gravar depois da falha. | Aceito (débito). |

Latente: `memoryScope: finn-<agente>` é global; vira vazamento entre motoristas se o TODO `neuralake-memory` for ligado.

## Mutações

31 mutações rodadas numa cópia fora do repositório. Pegas pelos testes do implementador: 27. Pegas só pelos do qa: M2 (B1) e M8 (N7). Equivalentes: M16, M17. M24 descartada (no-op).

## Testes

- `npx vitest run` nos 30 arquivos afetados: 516 passaram, 0 falharam. `npx vitest run tests/qa`: 41 passaram. Cópia de mutação, suíte completa sem mutante: 663 passaram, 4 ignorados. `tsc --noEmit` e `eslint tests/qa` limpos.
- Os testes `FINDING` em `tests/qa/driver-isolation-qa.test.ts` fixam o comportamento indesejado (N1, N3, N4, N6, N10). Quem corrigir deve inverter a asserção.

## Não verificado

Upstash real; cabeçalhos de IP da Vercel; PWA real; ramos `!process.env.VITEST` de `runToolLoop` (`deterministicFallback` e fast-path) com continuação e Redis fora; multi-instância; latência do Upstash; varredura geral de logs.
