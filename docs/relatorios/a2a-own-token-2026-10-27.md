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
