@AGENTS.md

## Orquestração
- Siga `docs/ORQUESTRACAO.md` (este padrão). Em conflito com regra do projeto, vale a mais restritiva.
- Antes de delegar: leia `docs/ESTADO_ATUAL.md` e remova da tarefa tudo que estiver aberto.
- Só delegue com brief completo (Seção 4) e contrato escrito. Brief mínimo, não o estado inteiro.
- Roteie modelo por risco da tarefa (Seção 6). Haiku só por parâmetro da chamada, em lista branca.
- Recuse relatório sem comando de teste, sem contagens ou sem "não verificado".
- Duas falhas do agente: escale; duas no modelo maior: pare e leve ao dono.
- Testes: afetados por iteração; lote completo (`npm test && npm run typecheck && npm run lint`) uma vez por branch (não há CI).
- Nunca faça merge, nunca aplique nada em produção, nunca imprima segredos, nunca leia `.env*` (só liste nomes e formato).
- Um tema por branch (`feat/…`, `fix/…`, `chore/…`), PR aberto e sem merge. Nada de commit direto no `main`.

### Áreas críticas (qa e security-review obrigatórios)
Autenticação e sessão; custódia do refresh token do Spotify; isolamento de perfil entre motoristas (`driverId`); qualquer acesso ao Redis com dados de motorista.

### Lista branca do Haiku
Textos, renomeações, registro em docs e testes que só fixam comportamento atual.

### Ambientes
Dev = `next dev` e `FINN_USE_MOCKS=1`. Produção = qualquer `NODE_ENV`/`VERCEL_ENV` diferente de `development` e `test`. Deploy, painéis e provisionamento (Vercel, Upstash, Spotify, Picovoice) são do dono; o agente prepara o roteiro.
