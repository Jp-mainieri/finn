# A2A com segredo próprio (security-review A2) — 2026-10-27

1. O que mudou
- `src/lib/auth.ts`: novo `authorizeA2A(request)`. Lê `FINN_A2A_TOKEN`; ausente, vazio, só espaços ou inválido (< 32 chars, espaço interno, < 10 caracteres distintos) -> 503 "A2A endpoint disabled" (falha fechada; 503 porque é estado do servidor, não erro de credencial do cliente). Bearer ausente/errado -> 401 + `WWW-Authenticate: Bearer`. Comparação por sha256 + `timingSafeEqual`. Nada é logado.
- `authorize()` antigo REMOVIDO (sem nenhum uso restante). `legacyMatches` e `authorizeA2A` compartilham `digestEquals`.
- `src/app/api/agents/[agent]/route.ts` usa `authorizeA2A`. Card e demais rotas intocados.
- Testes: harness define `FINN_A2A_TOKEN` (`TEST_A2A_TOKEN`); `callA2A` usa esse token por padrão.
- `.env.example`: só `FINN_A2A_TOKEN` (formato, nota "sem a variável o A2A fica desligado"); ajustei o comentário do `FINN_API_TOKEN` (não cobre mais `/api/agents/*`).

2. Testes
- `npm test`: 549 passed, 4 skipped (baseline antes: 533 passed, 4 skipped). `npm run typecheck`, `npm run lint`, `npm run build`: ok.
- Removidos 3 testes de `describe("authorize")` em `src/lib/auth.test.ts` (503 sem token, 401 errado, aceita certo): só exercitavam o `authorize()` removido; equivalentes reescritos para `authorizeA2A` (mais fortes). O teste de grep da rota agora exige `authorizeA2A(request)`.
- Novos: A2A desligado (sem var/vazio/espaços/curto/trivial/espaço interno), `FINN_API_TOKEN` não abre (flag legada ligada e desligada), token certo abre, errado/ausente 401, card público sem as duas variáveis, `/api/orchestrator` não afetado (aceita API token, rejeita A2A token). Testes de acceptance de auth parametrizados por endpoint, nenhum removido.

3. Não verificado
- Nada contra Vercel/rede. Rotas realtime só indiretamente (suítes existentes passam; não tocadas).

4. Decisões para o dono
- Nenhuma nova. Variável NÃO criada na Vercel (conforme ESTADO_ATUAL): A2A fica desligado em produção até criar.

5. Desvios
- `docs/ARCHITECTURE.md` linha 62 ainda diz que `/api/agents/*` usa `FINN_API_TOKEN` via `authorize()`; fora do meu escopo, precisa de docs-sync. Idem `tests/MANUAL.md` e `tests/smoke/smoke.mjs` (não verifiquei se chamam o A2A com o token compartilhado).

## Rodada de correções
- Item 1 (N1/M3) corrigido: FINN_A2A_TOKEN igual a FINN_API_TOKEN (digest, após trim) -> 503 igual ao "desligado". O orchestrator segue aceitando o valor como API token pelo caminho legado (comportamento existente, não alterado; o teste confirma que A2A não o afeta).
- Item 2 (M2/N5) corrigido: `authorizeA2A` reutiliza `isAcceptableSecret` de `@/lib/driver` (64 hex, >= 8 distintos, maiúsculas/minúsculas aceitas), sem mudar nada do que existia. Comentário de "1234..." removido. Testes: 31/32/63/64/65, não-hex, poucos distintos (2 e 7), espaço interno, maiúsculas.
- Item 3 (N2) corrigido: uma linha `[a2a] disabled: FINN_A2A_TOKEN missing or invalid` por processo (flag em módulo, `resetA2ADisabledLogForTests` só para teste). Teste com espião: 1 chamada, sem nenhum valor.
- Item 4 (B1/B2) corrigido: smoke aceita 401 ou 503 para /api/agents/* sem token/token errado, com mensagem nova; chamada autenticada ao A2A só com FINN_A2A_TOKEN, senão pula com aviso; orchestrator segue com FINN_API_TOKEN. tests/MANUAL.md atualizado.
- Item 5 corrigido: .env.example (64 hex, openssl rand -hex 32, diferir do API token, sem a variável fica desligado; valor vazio).
- Testes: `npm test` 558 passed, 4 skipped (antes da rodada 549). typecheck, lint, build ok. Nenhum teste removido ou afrouxado; o token de teste A2A virou 64 hex.
- Não verificado: o smoke não foi rodado contra um deploy real (só `node --check` de sintaxe). Sem rede.
