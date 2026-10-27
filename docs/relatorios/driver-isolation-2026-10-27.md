# Relatório: entrega 3, isolamento por motorista (branch feat/driver-isolation)

Contrato: `docs/contratos/isolamento-por-motorista.md` (aprovado). Modelo: Sonnet. Três commits na ordem do contrato.

## 1. O que mudou (por arquivo)

Passo 1, trava (commit 87e041c)
- `src/lib/contracts/a2a.ts`: `AgentTaskInput.driverId` obrigatório (só o servidor preenche); `savedAddresses` marcado `@deprecated` e ignorado.
- `src/lib/spotify/auth.ts`: `getAccessToken({driverId,...})`. Não dono: só token próprio; sem token, `UserFacingError("Conecte seu Spotify.")` sem rede; token próprio falhando falha, sem `SPOTIFY_REFRESH_TOKEN`. Caches de módulo (`cachedToken`, `rotatedRefreshToken`) só no caminho do dono. Os dois fallbacks cruzados saíram (e o desvio `process.env.VITEST`).
- `src/lib/spotify/{api,player,playlists}.ts`: `driverId` obrigatório em `SpotifyRequest`; `player`/`playlists` recebem `who: SpotifyIdentity` no lugar do `refreshToken` posicional.
- `src/agents/spotify/tools.ts`: `whoIs(input)` (driverId do servidor + token do próprio motorista).
- `src/lib/waze/address-book.ts`: `LayeredAddressBook` removida; `getAddressBook(driverId)`.
- `src/agents/waze/index.ts`: livro por `input.driverId`; `driverContext.savedAddresses` ignorado.
- `src/orchestrator/orchestrate.ts`: `driverId` obrigatório em `OrchestrateOptions`, repassado ao agente.
- `src/app/api/orchestrator/route.ts`: `driverId = auth.driverId`; do `driverContext` do cliente só sobra `spotifyRefreshToken` (o resto é descartado); `contextId` validado como string.
- `src/lib/a2a-server.ts`: `driverId: LEGACY_OWNER_DRIVER_ID` fixo.

Passo 2, endereços no Redis (commit 750de0c)
- `src/lib/waze/address-book.ts`: `AddressBook`, `MemoryAddressBook`, `UpstashAddressBook`, `SeededAddressBook` (dono: Redis, depois semente somente leitura), `normalizeAddress` (trim, 1..200, sem controle), `InvalidAddressError`, `getAddressBook(driverId, env)` (id inválido lança; produção sem variáveis lança).
- `src/lib/driver/store.ts`: `keys.driverAddr` (`finn:<env>:driver-addr:<id>`, valida o id). `src/lib/driver/index.ts`: `resolveDriverBackend(env)` extraído de `createDriverStore` (mesma regra), `hashToRecord` reexportado.
- `src/agents/waze/tools.ts`: valida a resposta do endereço (inválido: pede de novo, mantém `pendingLabel`); `DriverStoreUnavailableError` vira `UserFacingError("Não consegui acessar seus endereços agora.")` sem log. `prompt.ts`: instrução para `invalid_address`.
- `save_address` continua sendo emitido (quando há `driverContext`), com o endereço normalizado.
- `parseSavedAddresses` não loga mais o erro de `JSON.parse` (a mensagem cita trecho do endereço).

Passo 3, A2A (este commit)
- `src/lib/auth.ts`: `a2aSecrets()` (TOKEN + NEXT opcional; inválido/igual a outro/igual ao `FINN_API_TOKEN` desliga tudo, 503); `authorizeA2A` (só segredo) e `guardA2A` (Redis `ratelimit:a2a:<ip>`, 10 falhas/600 s; `noip` 3; peek antes de comparar o Bearer, só falhas contam; 429 + `Retry-After`; Redis fora = 503).
- `src/lib/driver/{store,memory-store,upstash-store}.ts`: `peekRateLimit` (GET; resposta não numérica lança o erro genérico); `RedisLike.get`.
- `src/lib/continuation.ts`: `boundedContinuation` (máx. 2 KB). Usado em `/api/orchestrator` e A2A. Parsers estritos por agente: waze passa adiante só a continuação parseada; spotify descarta qualquer uma.
- `src/lib/a2a-server.ts`: artifact `result` = `{agent,status,speech}` (`A2APublicResult`); `parts` não-array e partes malformadas não dão mais 500 (-32602); `contextId` limitado a 128.
- `src/app/api/agents/[agent]/route.ts`: `await guardA2A(request)`.
- `docs/procedimentos/rotacao-token-a2a.md` (criar, rotacionar, revogar, limite); `.env.example`: só o nome `FINN_A2A_TOKEN_NEXT`, comentado.

## 2. Testes rodados
Linha de base: 558 passaram, 4 ignorados. Resultado final, no HEAD:
- `npm test`: 43 arquivos passaram, 1 ignorado; 630 testes passaram, 4 ignorados, 0 falharam.
- `npm run typecheck`: 0 erros. `npm run lint`: 0 problemas. `npm run build`: ok (rotas de API dinâmicas).
- Por commit (`npm test`): passo 1 = 567 passaram; passo 2 = 592; passo 3 = 630.
- Novos: `src/lib/spotify/isolation.test.ts`, `src/app/api/orchestrator/route.test.ts`, `src/app/api/agents/[agent]/route.test.ts`, `src/lib/a2a-guard.test.ts`, e acréscimos em `address-book.test.ts`, `waze/index.test.ts`, `waze/tools.test.ts`. Nenhum teste faz rede (fetch global é falso; Redis = SDK real sobre fetch falso ou store em memória).
- Mapa do "Critério de pronto": B nunca lê A (Memory e Upstash); não dono nunca usa o token do servidor (sem token, token falhando, cache do dono quente, token igual ao do servidor); semente do dono só leitura e sem escrita global; `driverId` no corpo/`driverContext`/`continuation`/cookie ignorado (rota do orquestrador e do A2A); `savedAddresses` ignorado; Redis fora: fala curta, console.error/warn não chamados, sem cair no global (agente, produção sem variáveis); A2A: 429, `noip`, dois segredos, iguais rejeitados, continuação hostil e acima de 2 KB, artifact sem `toolCalls`/`clientActions`; chave com prefixo de ambiente, produção sem variáveis falha fechada.

## 3. Não verificado
- Nada foi exercido contra Upstash, Vercel ou Spotify reais; o formato de resposta do Upstash vem do fake (flat array no HGETALL, GET como string) e do que o código já assumia.
- Hipótese herdada: `x-vercel-forwarded-for` não é forjável na Vercel (ver `client-ip.ts`). Fora da Vercel o limite por IP é contornável com cabeçalhos.
- Concorrência: peek e increment não são atômicos; N requisições paralelas ultrapassam o limite em até N. Com segredo de 64 hex isso não torna adivinhação viável, mas o teto "10" não é exato.
- Atrás de NAT compartilhado, 10 falhas bloqueiam todos do IP por 10 min (inclusive o cliente certo).
- Não rodei o fluxo real do PWA contra o servidor; `save_address` continua sendo emitido, mas o PWA não foi aberto.
- `.env.example` só foi anexado (`>>`), sem leitura: pode já haver menção a `FINN_A2A_TOKEN` e a posição do comentário não foi conferida.
- Não li `docs/ESTADO_ATUAL.md` nem `ARCHITECTURE.md` e não os atualizei (fora do meu escopo).
- Antes de qa/security-review: o diff completo foi estável, mas nenhuma revisão independente foi feita.

## 4. Decisões para o dono / pontos para o orquestrador
- Consequência do ponto 6: o cliente A2A externo não recebe mais `continuation`, então o fluxo "waze pergunta o endereço de casa" só continua se o cliente já souber enviar `{pendingLabel}`. Contrato manda assim; reabrir só se houver cliente A2A real.
- A `speech` é frase do modelo e pode conter o endereço falado (o prompt manda não ler endereço completo). Não é filtrada no servidor.
- Rota de purga de endereços (débito do contrato) continua pendente: `revokeDriver` não apaga `driver-addr:*`.

## 5. Desvios e decisões técnicas
- Fora da lista literal de escopo, mas dentro de `src/lib/**` e `tests/**`: `src/lib/spotify/{api,player,playlists}.ts`, `src/lib/driver/{store,index,memory-store,upstash-store}.ts` (necessários para o `driverId` chegar ao token e para o peek do limitador), `src/lib/continuation.ts`, `tests/helpers/{http,assertions}.ts` e `tests/acceptance/{a2a,waze}.test.ts`.
- `DriverStore` ganhou `peekRateLimit` (interface de store, não contrato congelado): "10 falhas por IP" exige ler o contador sem incrementar antes de comparar o Bearer; o `incrementRateLimit` existente conta toda tentativa e bloquearia o cliente legítimo.
- `authorizeA2A` continua síncrono (só segredo, serve de base para os testes antigos); a rota usa `guardA2A`. Padrões do limite ajustáveis por parâmetro (`deps`), sem variável de ambiente nova (não decidi nome).
- Teste de aceitação A2A alterado por mudança de comportamento do contrato (artifact público). O helper `callA2A` passa a mandar um IP novo por chamada, para não acoplar testes pelo limitador compartilhado.
- NEXT sozinho (sem TOKEN) mantém o endpoint desligado; NEXT inválido desliga o endpoint inteiro (não "ignora o ruim").
- Dono com token próprio diferente do do servidor continua usando o próprio (comportamento anterior), sem fallback para o do servidor.

# Rodada 2 (correções de qa e security-review)

Fontes: `docs/revisoes/driver-isolation-qa.md` e `driver-isolation-security-review.md` (não editados). Um commit novo sobre 122e141.

## O que mudou
- B1: `src/agents/spotify/index.test.ts` ganhou 3 testes de fiação com `driverId` de não dono (sem token: "Conecte seu Spotify." e zero chamadas; token ruim: o refresh token do servidor nunca aparece; dono continua no token do servidor). Mutação testada de verdade: com `whoIs()` fixando o `driverId` do dono em `src/agents/spotify/tools.ts`, o teste "sem token" falha (1 falhou, 20 passaram); mutação revertida (`git checkout`).
- N2/M2: `guardA2A` devolve 401 para Bearer ausente ou fora de 64 hex sem tocar no store (503 de endpoint desligado continua antes de tudo). Não conta como falha. Teste com store espião: zero chamadas; com Redis fora também é 401. Testes antigos que usavam "wrong" passaram a usar um valor de 64 hex.
- N3: `wazeAgent.handle` resolve o livro de forma preguiçosa (só em `get`/`set`); falha de resolução vira o erro genérico do store. Destino explícito navega com Redis fora e com produção sem `KV_*` (teste: nem o `fetch` é chamado).
- N4/N5: `normalizeAddress` rejeita surrogate solto (`isWellFormed`), U+2028/2029, bidi U+202A-202E e U+2066-2069, zero-width U+200B-200D, U+2060, U+FEFF (um teste por classe).
- N6: comparação TOKEN/NEXT/`FINN_API_TOKEN` em minúsculas (teste com maiúsculas nas três combinações).
- N7: teste de `driverId` hostil no A2A reescrito: o id vem em `params.message`, nas partes e no data part (a mutação `message.driverId ?? OWNER` o derruba).
- N10: `/api/orchestrator` responde 400 a corpo JSON que não seja objeto (null, array, número, string, boolean); cookie com `%` inválido é tratado como ausente.
- N1/B3: comentário de `guardA2A` corrigido; `docs/procedimentos/rotacao-token-a2a.md` documenta limitador não atômico, 429 também para o segredo certo, 401 direto sem Redis e o passo "conferir casa e trabalho do dono" após vazamento.
- Curadoria: `tests/qa/driver-isolation-qa.test.ts` virou `tests/acceptance/driver-isolation.test.ts` (diretório `tests/qa` removido). FINDING corrigidos (N3, N4, N6, N10) com asserção invertida; débitos mantidos com nome "debt": rajada paralela (N1) e balde `noip` compartilhado (N11, teste novo). Testes de garbage de Authorization agora afirmam zero contagem.

## Testes rodados
`npm test && npm run typecheck && npm run lint && npm run build`: 44 arquivos passaram, 1 ignorado; 700 testes passaram, 4 ignorados, 0 falharam (630 antes, mais os testes do qa agora em `tests/acceptance` e os novos desta rodada). typecheck 0 erros, lint limpo, build ok.

## Desvios
- Teste do qa movido para `tests/acceptance` em vez de manter `tests/qa`. Nada fora do escopo editado. Não implementei os itens marcados "não fazer".

## Não verificado
- Só a mutação do B1 foi executada de fato; as demais correções foram conferidas por raciocínio (remover a checagem de 64 hex, o resolver preguiçoso ou a minúscula faz o teste correspondente falhar), não rodadas.
- `isWellFormed` exige Node 20+; o ambiente de deploy não foi conferido.
- Continuam valendo os não verificados da rodada 1 (nada contra Upstash/Vercel/Spotify reais, hipótese do IP, PWA real).
