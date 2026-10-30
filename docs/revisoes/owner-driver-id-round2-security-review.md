# Security review pontual: rodada 2 da entrega 5a (`21d445f`, `feat/owner-driver-id`)

Escopo: `git diff 638f7b6..21d445f`. Código de produção alterado: `src/lib/auth.ts` e `scripts/lib/admin-cli.mjs`. O resto do diff são testes e docs. Não é revisão completa e não aprova merge.

Testes: `npx vitest run src/lib/owner.test.ts src/lib/a2a-guard.test.ts src/lib/auth.test.ts tests/acceptance tests/scripts/admin-cli.test.ts` deu **16 arquivos, 437 testes, 437 passaram**. Também rodei uma sonda em `node -e` sobre `.trim()` com a regex de `isValidDriverId`, sem tocar na árvore.

## Resumo

| Sev. | Id | Achado |
|---|---|---|
| Crítico | nenhum | |
| Alto | nenhum | |
| Médio | nenhum | |
| Baixo | B1 | No A2A, uma falha do store na consulta ao dono responde "A2A endpoint disabled" e gasta o log único com motivo errado |
| Baixo | B2 | No CLI, revoke/purge/rotate ficam calados quando `FINN_OWNER_DRIVER_ID` falta no ambiente do script, e a variável do shell vence a do `--env-file` |
| Baixo | B3 | Docstrings desatualizadas e literal do id legado duplicado no CLI |
| Info | I1–I4 | Oráculo 503/401 equivalente ao sucesso, `.trim()` com Unicode nas pontas, TOCTOU, resíduo do M2 |

## O que fechou (Fato, por leitura e pelos testes)

- **M1 / N3.** Com o dono real, o token legado (`auth.ts:235-241`) e o A2A (`auth.ts:123-132`) exigem `getDriver(owner)` ativo. Dono revogado ou ausente dá 401 no legado e 503 no A2A. Se o store cair, as duas rotas falham fechado. `driver:rotate` não corta nenhuma das duas, e isso está decidido e documentado.
- **N1.** Só as pontas são aparadas (`auth.ts:166`). Depois disso a regex ASCII `^drv_[A-Za-z0-9_-]{22}$` é exata. `isOwner` (`auth.ts:190-194`) continua comparando o `driverId` recebido com `===`, sem trim.
- **N4.** O id legado como valor da variável é inválido (`auth.ts:169`, `admin-cli.mjs:127`).
- **Ordem no A2A.** A sequência é: configuração (503, sem Redis), formato do Bearer (401, sem Redis), `peekRateLimit`, comparação em tempo constante e, **só com o segredo certo**, `getDriver`. Com Bearer errado o caminho segue igual (peek e incr) e não consulta o dono, o que o teste confirma. Com o segredo certo e o dono fora, nada é contado no limitador.
- **Custo de Redis.** O token legado ganha um GET por requisição, e só depois de `legacyMatches`. Token legado errado não chega ao Redis. Não há amplificação vinda de quem não tem o segredo.
- **Dono = id legado.** `ownerCredentialsLive` retorna `true` sem consultar o store (`auth.ts:184`). O teste prova que `getDriver` não é chamado. Não passou a exigir registro.
- **Sessão `v1.`.** O caminho não foi tocado pelo diff (`auth.ts:244-251`).
- **Helper de testes.** `tests/helpers/owner.ts` não é importado por `src/` nem por `scripts/` (grep). `setDriverStoreForTests` só tem uso em testes e em `src/lib/spotify/testing.ts`.
- **CLI.** A marca "(dono)" e o aviso "ATENÇÃO" não imprimem nenhum id novo. O aviso vai para stderr, e o id já aparecia na linha "Alvo:" em stdout. O CLI não imprime segredo. A confirmação, o `--yes` sem TTY e o `--confirm-production` não mudaram (`admin-cli.mjs:166-168, 241-248`).
- **Regressão das entregas 3, 4 e 5a.** O diff não altera código de isolamento, custódia ou `driverContext`. As suites de aceitação `driver-isolation`, `spotify-custody`, `old-pwa-driver-context` e `owner-5a-attack` passam.

## B1. No A2A, uma falha do store na consulta ao dono vira "disabled" (baixo)

**Fato.** Em `auth.ts:126-130` uma exceção de `getDriver` retorna `a2aDisabled()`: 503 `{"error":"A2A endpoint disabled"}`, sem `Retry-After`. O log único por processo de `auth.ts:22-25` diz "FINN_A2A_TOKEN missing or invalid, or no owner". O mesmo Redis fora no `peekRateLimit` (`auth.ts:119-120`) responde `unavailableResponse()`, com 503 e `Retry-After: 5`.

**Hipótese.** Um blip do Redis consome a única linha de log do processo com o motivo errado. Se depois aparecer uma configuração realmente inválida, ela fica sem diagnóstico. Um cliente A2A também pode tratar "disabled" como permanente e parar de tentar. A falha continua fechada, então não há bypass.

**Correção sugerida.** Separar os casos. Exceção do store vira `unavailableResponse()`. Dono revogado ou ausente continua `a2aDisabled()`. Uma alternativa é manter o 503 "disabled" e não armar o log quando a causa for o store.

## B2. O CLI fica calado sobre o dono quando a variável falta no ambiente do script (baixo)

**Fato.** `driver:list` avisa quando `FINN_OWNER_DRIVER_ID` falta (`admin-cli.mjs:208`), mas `driver:revoke`, `driver:purge` e `driver:rotate` não avisam (`admin-cli.mjs:222-223`). A falta do "ATENÇÃO" não prova que o alvo não é o dono. Com `--yes`, ou numa confirmação no TTY, o dono revoga a si mesmo sem aviso. O roteiro documenta essa dependência, mas o comando não. Além disso, `process.loadEnvFile` não sobrescreve variáveis já presentes no processo (`admin-cli.mjs:29-30, 174`). Um `FINN_OWNER_DRIVER_ID` exportado no shell para outro ambiente marca a linha errada, ou nenhuma, em `--env production`.

**Hipótese.** O impacto é a autoindisponibilidade do carro, que se recupera com convite novo, troca da variável e reimplantação. Nenhum dado de um motorista fica acessível a outro.

**Correção sugerida.** Repetir nos três comandos de mutação o aviso "FINN_OWNER_DRIVER_ID não definida neste ambiente; não sei se o alvo é o dono". Opcionalmente, exigir confirmação interativa ou uma flag explícita (`--owner`) quando o alvo for o dono, mesmo com `--yes`.

## B3. Documentação interna desatualizada e literal duplicado (baixo)

**Fato.** O docstring em `auth.ts:159` ainda diz "exact value, no trim", o que contradiz a linha 166. O docstring de `guardA2A` (`auth.ts:92-100`) não menciona a consulta ao dono nem o 503 "disabled" com o segredo certo. O CLI repete o literal `"drv_legacy_owner_000000000"` (`admin-cli.mjs:127`) em vez de importar `LEGACY_OWNER_DRIVER_ID`, então se uma das cópias mudar o CLI e o servidor passam a divergir sobre quem é o dono.

**Correção sugerida.** Atualizar os dois docstrings. Exportar a constante de um módulo sem alias (por exemplo `src/lib/driver/`) e importá-la no CLI, ou incluir um teste que compare os dois valores.

## Informativos

- **I1. Oráculo 503/401 (Fato).** Com o dono revogado ou ausente, ou o store fora, o segredo A2A certo recebe 503 e o errado recebe 401. No legado com o store fora, o token certo recebe 503 e o errado 401. Isso só revela o que um acerto já revelaria (o normal seria 200). O segredo A2A tem 64 hex e chutes errados continuam passando pelo limitador. Nenhuma ação.
- **I2. `.trim()` com Unicode (Fato, pela sonda).** BOM, NBSP, U+3000, U+2028 e `\v` nas pontas são removidos, e o que sobra precisa casar com a regex ASCII exata, então o id final é idêntico ao canônico. Continuam inválidos: NUL (na ponta ou no meio), ZWSP, `\r\n` no meio, caracteres de largura total, aspas e espaço no meio. Nenhum valor ambíguo vira id. Nenhuma ação.
- **I3. TOCTOU (Fato e Hipótese).** O status do dono é verificado a cada requisição. Uma requisição já autorizada termina mesmo que a revogação ocorra no meio dela, igual ao que acontece com as sessões `v1.`. `a2a-server.ts:44` relê `getOwnerDriverId()` do env, que é constante no processo.
- **I4. Resíduo do M2 (Fato).** Um id válido de convidado ativo em `FINN_OWNER_DRIVER_ID` passa na nova checagem e vira dono. A mitigação continua só operacional: a marca "(dono)" e a prova com a sessão `v1.` no roteiro. Isso é coerente com o contrato e fica registrado como aberto por desenho.

## Não verificado

- Não rodei o lote completo (`npm test && npm run typecheck && npm run lint`), só os 16 arquivos afetados.
- O comportamento real no Upstash de `getDriver` com registro corrompido (exceção ou `null`) não foi testado. Por leitura, as duas saídas falham fechado.
- O tempo de vida de credenciais emitidas por `/api/realtime/*` depois de revogar o dono (I3) não foi verificado.
- A suite com o store global do helper depois de `restore()` em `spotify/testing.ts` (o dono deixa de estar registrado nos testes seguintes) é só fragilidade de teste e não foi auditada.
