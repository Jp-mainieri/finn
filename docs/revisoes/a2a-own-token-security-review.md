# Security review: A2A com segredo próprio (`feat/a2a-own-token`)

- Data: 2026-10-27
- Escopo: `git diff feat/driver-session-routes..HEAD` (commit `3e61abc`, 8 arquivos). Também li o que o diff toca ou passa a proteger: `src/app/api/agents/[agent]/card/route.ts`, `src/lib/a2a-server.ts`, `src/agents/waze/index.ts`, `src/lib/spotify/auth.ts`, `next.config.ts`, `tests/smoke/smoke.mjs` e as referências a `authorize(`, `FINN_API_TOKEN`, `FINN_A2A_TOKEN` e `/api/agents` no repositório inteiro (`git grep`).
- Referências: achado A2 de `docs/revisoes/driver-session-routes-security-review.md`, decisão A2 de 2026-10-27 em `docs/ESTADO_ATUAL.md:33` e o relatório do autor em `docs/relatorios/a2a-own-token-2026-10-27.md`.
- Decisões já tomadas e não reabertas aqui: segredo próprio para o A2A, desligado sem a variável, variável ainda não criada na Vercel.
- Este documento **não aprova merge**. Ele só relata.
- Legenda: **Fato** = verificado lendo o código ou executando-o localmente. **Hipótese** = depende de comportamento externo (Vercel, valores reais das variáveis, ação do dono) que não verifiquei.
- Verificação local, sem rede e sem ler `.env*`:
  - `npx vitest run src/lib/auth.test.ts tests/acceptance/auth.test.ts tests/acceptance/a2a.test.ts`: 3 arquivos, 79 testes, todos passaram.
  - Sonda em Node: `new Set("12345678901234567890123456789012").size` dá 10, e o tamanho é 32.

## Resumo

| Severidade | Qtde | Itens |
|---|---|---|
| Crítico | 0 | |
| Alto | 0 | |
| Médio | 3 | M1, M2, M3 |
| Baixo | 5 | B1 a B5 |

O A2 está fechado no código (Fato):
- `src/app/api/agents/[agent]/route.ts:7` chama só `authorizeA2A`, antes de ler `params` ou o corpo;
- `authorizeA2A` (`src/lib/auth.ts:23-31`) lê só `FINN_A2A_TOKEN` e não chama `legacyMatches`, `authenticateSession` nem `authorizeDriver`. Logo, nem `FINN_API_TOKEN` (com a flag ligada ou desligada), nem token de sessão `v1.`, nem o token legado abrem o A2A;
- quando a variável está ausente, vazia, só com espaços ou inválida, a resposta é 503 antes de qualquer comparação, ou seja, falha fechada (`auth.ts:24-27`);
- a comparação usa sha256 dos dois lados e depois `timingSafeEqual` sobre 32 bytes fixos (`auth.ts:7-9`), então nem o tamanho nem o conteúdo do segredo vazam por tempo;
- nada é logado. As respostas são fixas (`"A2A endpoint disabled"` e `"Unauthorized"`) e não ecoam valores;
- o `authorize()` antigo foi removido e não sobrou nenhum uso (`git grep "authorize("` só acha documentação);
- `handleA2ARequest` só é chamado em `route.ts:13`. O orquestrador usa os agentes em processo, atrás de `authorizeDriver`, e isso não mudou;
- não surgiu superfície nova. O diff não toca `package.json`, `package-lock.json`, `vercel.ts`, `next.config.ts` nem outra rota além de `src/app/api/agents/[agent]/route.ts`. O card (`card/route.ts`) não mudou e não alcança agentes: só chama `agent.card(...)`.

Os pontos abertos são três: o guarda de força do segredo é mais fraco do que o comentário promete (M2); nada impede que o dono reaproveite o valor do `FINN_API_TOKEN`, o que recriaria o A2 em silêncio (M3); e, quando o A2A for ligado, o risco que já existia (Spotify do dono, livro de endereços global, nenhum limite) volta inteiro (M1).

## Médio

### M1. Quando ligado, o A2A continua rodando os agentes com o Spotify do dono e o livro de endereços global, sem limite, sem identidade de cliente e sem expiração (Fato no código; impacto condicional, Hipótese)

- O handler A2A chama `agent.handle({ transcript, contextId, continuation })` sem `driverContext` (`src/lib/a2a-server.ts:66`).
- Por isso o Waze cai em `getAddressBook()` global (`src/agents/waze/index.ts:88-89`), e o Spotify usa o `SPOTIFY_REFRESH_TOKEN` do servidor (`src/lib/spotify/auth.ts:112`).
- A resposta devolve o `result` inteiro do agente como artifact (`a2a-server.ts:81`). A `continuation` vem do cliente sem validação (`a2a-server.ts:60-63`).
- Não há limite de taxa em `/api/agents/*`: o limitador existe só em `src/lib/driver/*`. Falhas de Bearer não são contadas.
- O `FINN_A2A_TOKEN` é um segredo estático. Ele não expira, não é por cliente e só pode ser revogado trocando a variável e fazendo novo deploy (deploy = Hipótese).
- Hoje isso fica neutralizado, porque a variável não existe em produção (`ESTADO_ATUAL.md:33`, Hipótese: não verifiquei a Vercel). No dia em que o dono criar a variável, quem tiver o valor controla o player e lê os endereços do dono. Nesse dia o risco passa a ser **alto**.
- O que a entrega 3 (ou qualquer passo antes de criar a variável para um cliente externo) deve fazer:
  1. Decidir de quem são os recursos de uma chamada A2A. Ou o A2A vira explicitamente só do dono (documentado, com o segredo tratado como credencial do dono), ou ele carrega um `driverId` provado no servidor (nunca vindo do corpo nem da `continuation`) e passa `driverContext` e o Spotify desse motorista.
  2. Não usar o livro de endereços global no caminho A2A, ou limitá-lo ao do dono por decisão registrada.
  3. Limitar a taxa por IP e por falha de Bearer em `/api/agents/*` (Redis com prefixo próprio ou Firewall da Vercel). O limite não pode ficar só em memória.
  4. Dar ao segredo um caminho de revogação e rotação: aceitar dois valores durante a troca, ou um segredo por cliente com identificador, com procedimento escrito.
  5. Validar a `continuation` vinda do cliente, ou assiná-la no servidor, antes de devolvê-la ao agente.
  6. Revisar o que o artifact `result` expõe para um cliente externo.

### M2. A validação de força aceita segredos triviais e o comentário diz o contrário (Fato)

- `src/lib/auth.ts:11-14` exige pelo menos 32 caracteres, nenhum espaço e pelo menos 10 caracteres distintos.
- O comentário promete rejeitar `"1234..."`. Só que `"12345678901234567890123456789012"` tem 10 distintos e passa (sonda acima). O mesmo vale para `"abcdefghij"` repetido, ou para qualquer frase em inglês com 32 ou mais caracteres, como um placeholder do tipo "replace-with-your-own-secret-value".
- A regra não mede entropia. Ela barra `"aaaa..."` e valores curtos, mas não sequências nem texto previsível.
- Com M1 (nenhum limite de taxa), um valor fraco escolhido pelo dono pode ser adivinhado online (Hipótese: depende do valor real).
- Opções: (a) exigir formato gerado por máquina, por exemplo 43 ou mais caracteres base64url, ou 64 hex, e documentar o comando que gera; (b) rejeitar sequências e repetições; (c) no mínimo, corrigir o comentário para não prometer o que o código não faz. Os testes de `src/lib/auth.test.ts:11` não cobrem o caso `"1234..."`.

### M3. Nada impede `FINN_A2A_TOKEN` igual a `FINN_API_TOKEN`, o que reabre o A2 (Fato no código; uso, Hipótese)

- `authorizeA2A` (`auth.ts:23-31`) não compara o segredo novo com `FINN_API_TOKEN`.
- Se o dono colar o mesmo valor nas duas variáveis, o token que vive no celular, no `localStorage` do PWA (`src/lib/voice/token-store.ts`), volta a abrir o A2A. Isso vale mesmo com `FINN_LEGACY_TOKEN_ENABLED` desligado, que era exatamente o A2.
- Os testes provam que o *valor* do API token não abre o A2A quando os valores são diferentes (`src/lib/auth.test.ts:35-42`, `tests/acceptance/auth.test.ts:73-78`). O caso de valores iguais não é testado.
- Opção: tratar `FINN_A2A_TOKEN === FINN_API_TOKEN` (depois de `trim`) como inválido, com 503, e testar isso com `digestEquals`.

## Baixo

### B1. O 503 "A2A endpoint disabled" revela, sem autenticação, se o A2A está ligado (Fato)

- Em `auth.ts:25-26`, o 503 sai antes de olhar o Bearer. Qualquer pessoa sabe se o endpoint está desligado (503) ou ligado (401), e um atacante sabe quando vale a pena começar a tentar.
- A mensagem não diferencia "ausente" de "inválido" e não ecoa valor. O vazamento se resume a um bit de estado.
- O risco é baixo enquanto M1 e M2 estiverem tratados. Alternativa: responder 401 (ou 404) também quando desligado e deixar o estado só para quem opera. A escolha do autor (503 = estado do servidor) é defensável. Registro como aceitável, a critério do dono.

### B2. O smoke de produção passa a falhar no A2A, com uma dica que empurra para a variável errada (Fato no código; resultado em produção, Hipótese)

- `tests/smoke/smoke.mjs:101-104` espera 401 sem token em `/api/agents/*`. Com a variável ausente em produção, a resposta será 503, e a mensagem do assert diz "503 = FINN_API_TOKEN not set on the server".
- `smoke.mjs:129-130` chama `/api/agents/spotify` com `FINN_API_TOKEN` e espera 200. A resposta será 503 ou 401.
- Risco: para "fazer o smoke passar", alguém cria `FINN_A2A_TOKEN` antes da entrega 3 (M1) ou reutiliza o valor do API token (M3).
- O autor já registrou o risco como desvio. O ajuste é para o `docs-sync` ou para uma tarefa de teste.

### B3. A documentação ainda diz que `/api/agents/*` usa `FINN_API_TOKEN` via `authorize()` (Fato)

- Os trechos desatualizados estão em `docs/ARCHITECTURE.md:62`, `docs/contratos/identidade-e-perfil.md:51` e `tests/MANUAL.md:12`.
- Risco: alguém lê a documentação e reintroduz o token compartilhado no A2A. O autor já registrou parte disso.

### B4. O card público continua anunciando o endpoint mesmo com o A2A desligado (Fato)

- `src/app/api/agents/[agent]/card/route.ts:9` e `src/agents/{spotify,waze}/card.ts` publicam `url` e skills.
- Nada mudou no diff e o card não abre os agentes. É só informativo, porque o card anuncia uma superfície que responde 503. Quando o A2A for ligado para um cliente, vale declarar o esquema de autenticação no card, sem nenhum segredo.

### B5. Não verifiquei o placeholder do `.env.example` (Hipótese)

- O diff altera `.env.example`, mas a regra da tarefa proíbe ler `.env*`, então não li.
- Se o placeholder de `FINN_A2A_TOKEN` tiver 32 ou mais caracteres, sem espaço e com 10 ou mais distintos, ele passa em `isValidA2ASecret` (ver M2). Copiado sem mudança, ligaria o A2A com um valor público.
- Também não confirmei que o arquivo não contém nenhum valor real. Quem pode ler deve conferir as duas coisas.

## Observações (não são achados)

- O antigo `authorize()` fazia `console.error` quando a variável faltava. O novo não loga nada. Isso é correto para segredo, mas um `FINN_A2A_TOKEN` com 31 caracteres deixa o A2A desligado sem nenhum sinal para quem opera. A falha continua fechada, portanto não é um risco de segurança.
- `extractBearer` (`auth.ts:47-52`) exige `Bearer ` com maiúscula e faz `trim`, e `digestEquals` faz hash do valor recebido, que tem o tamanho que o próprio atacante escolheu. Não há vazamento.
- Os constantes de teste (`tests/helpers/http.ts:13`, `src/lib/auth.test.ts:9`) são fictícios.
- Fora do escopo e anterior ao diff: `src/lib/spotify/auth.ts:129` loga o objeto `err` inteiro em `console.warn`. Não verifiquei se a mensagem de erro do Spotify pode carregar dados sensíveis.

## Verificação por item pedido

| Item | Resultado |
|---|---|
| Falha fechada com variável ausente ou inválida | Sim, `auth.ts:24-27` (Fato, testado) |
| Caminho alternativo com `FINN_API_TOKEN`, sessão ou legado | Nenhum (Fato). Só o reuso de valor, em M3 |
| Força do segredo (32 ou mais caracteres, distintos) | Implementada, mas fraca, em M2 |
| Tempo constante sem vazar tamanho | Sim, `auth.ts:7-9` (Fato) |
| Segredo em log, resposta ou erro | Nenhum (Fato) |
| Card expõe algo novo ou alcança agentes | Não (Fato), ver B4 |
| 503 revela estado | Sim, um bit, Baixo (B1) |
| Recursos do dono pelo A2A | Continuam, condicionados à variável, em M1 |
| Superfície nova (rotas, dependências) | Nenhuma (Fato) |
