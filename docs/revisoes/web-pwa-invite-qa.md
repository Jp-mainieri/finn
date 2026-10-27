# QA — entrega 5b (PWA com convite)

Branch `feat/pwa-invite-session` (4794140, e25d7df). Revisor: agente `qa` (Sonnet, esforço alto), 2026-10-27. Registrado pelo orquestrador a partir do relatório do agente (que não pôde gravar `.md`): resumo fiel, não o texto integral. Interrompido uma vez pelo limite de uso e retomado sem perda.

## Veredito

Nenhum bloqueante de segurança ou de correção funcional. Um **bloqueante condicional ao critério de pronto do contrato**: o `VoiceController` não tem nenhum teste no repositório (12 mutações de fluxo sobreviveram), e os testes exigidos pelo contrato ("401 volta à tela de convite", "Entrar com outro convite sobrescreve", "Sair apaga", reconsulta do Spotify) só existem em `tests/qa/`. O relatório do implementador ("sem jsdom, não dá para testar") está incorreto: o controller roda em Vitest `node` com `vi.stubGlobal("window", ...)` e `fetch` stubado. Correção: promover esses testes para `src/lib/voice/voice-controller.test.ts`.

34 mutações aplicadas numa cópia fora do repositório (árvore intacta). A lógica pura (`invite-client`, `spotify-connection`, `legacy-cleanup`, falhas 429/503) tem testes que falham quando a proteção é desfeita. Sobreviveram à suíte do repositório: M1 (gravar token antes de validar a forma), M4 (`Retry-After` 0/negativo/`Infinity`), M8 a M17 (controller e fala local) e a guarda estática (S2 a S5, S8, S9).

## Não bloqueantes

| # | Achado | Tratamento |
|---|---|---|
| N1 | Resgate, conexão e desconexão do Spotify sem timeout (a tela fica em "Entrando…"). | Corrigir (`AbortController`). |
| N2 | O cliente envia qualquer string não vazia e queima tentativas do rate limit (espaço/hífen no meio, travessão, zero-width, largura total). | Corrigir: limpar e validar a forma antes do POST. |
| N3 | `tests/MANUAL.md` promete "Confira o código." para código malformado; o servidor responde 401 ("Convite inválido."). | Corrigir a doc. |
| N4 | Forma do token fraca (aceita `"x"`, HTML, 200 KB, caractere fora de Latin-1 faz o `Headers` lançar). | Corrigir: `/^v1\.[A-Za-z0-9._-]+$/` e teto de 1024. |
| N5 | `Retry-After` sem teto ("1666666667 min"); `"0x10"` e `"1e3"` aceitos. | Corrigir: inteiro decimal, teto. |
| N6 | 401 das rotas do Spotify não volta à tela de convite; token rejeitado não é apagado no reload. | Corrigir. |
| N7 | `loading` preso após voltar do Spotify via bfcache sem `visibilitychange`. | Corrigir (`pageshow`); checklist iOS observa. |
| N8 | Resposta antiga de `refreshSpotify` sobrescreve a nova. | Corrigir (sequência). |
| N9 | `speakLocal` depende da fala nativa do iOS (pode ficar muda com o mic aberto; sobra a legenda). | Aceito; checklist iOS observa. |
| N10 | `GptLiveSession` não é instanciada em lugar nenhum (429/503 tipados lá são código morto). | Aceito. |
| N11 | `legacy-cleanup`: só 4 campos planos; sem fallback se `setItem` lançar; teste "does not take a Spotify token from the URL" é vazio. | Corrigir o fallback e o teste. |
| N12 | Guarda estática `no-device-secrets.test.ts` rasa (4 mutações sobrevivem; não cobre `.tsx`). | Corrigir: multi-linha, `localStorage.setItem` só nos arquivos permitidos, `dangerouslySetInnerHTML` nos `.tsx`. |
| N13 | Testes que não provam nada ("five failures have distinct messages"; "never calls the TTS route"). | Corrigir. |
| N14 | `ARCHITECTURE.md` lista os campos apagados incompletos; o relatório diz "no primeiro carregamento". | Corrigir a doc. |

## Testes

`npx vitest run src/lib/voice src/lib/contracts`: 14 arquivos, 126 passaram. `tests/qa/web-pwa-invite.test.ts`: 89 passaram (caracterização; não passou por lint nem typecheck). Conjunto afetado + `tests/qa`: 261 passaram.

## Não verificado

iOS (standalone, abertura do Spotify, retorno, bfcache, `speechSynthesis` com mic aberto); componentes `.tsx` (nenhum teste, só leitura); rotas reais; `GptLiveSession`; áudio real; concorrência real entre resgate e `signOut`/`cancelInvite`; lote completo e build (não pedidos ao qa).
