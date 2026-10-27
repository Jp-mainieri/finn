# Contrato — isolamento por motorista (etapa 1, entrega 3)

Status: **rascunho, aguardando aprovação do dono** (2026-10-27). Base: [`identidade-e-perfil.md`](./identidade-e-perfil.md) (entrega 3 da lista de entregas) e os achados C1 (entrega 2) e M1 (A2A) em `docs/revisoes/`.

## Objetivo

Hoje o orquestrador autentica o motorista mas não usa o `driverId`. O Spotify cai no `SPOTIFY_REFRESH_TOKEN` do dono e o Waze lê e grava um livro de endereços global. Esta entrega faz cada recurso do servidor pertencer a um `driverId` provado, e cobre as 6 pré-condições do M1 para um dia existir `FINN_A2A_TOKEN`.

**Esta entrega não libera convites em produção.** Falta a entrega 4 (refresh token do Spotify fora do `driverContext`).

## Invariantes

1. O `driverId` usado por agentes vem **só** de `authorizeDriver` (ou da identidade fixa do A2A). Nunca do corpo, do `driverContext`, da `continuation` ou de cookie.
2. "Dono" para recursos do servidor = `LEGACY_OWNER_DRIVER_ID` e mais ninguém. Só ele usa `SPOTIFY_REFRESH_TOKEN` e `WAZE_SAVED_ADDRESSES`.
3. Nenhuma escrita em estrutura global. Nenhuma leitura de dado de outro motorista.
4. Falha fechada: Redis fora do ar nunca cai no livro global nem no Spotify do dono.
5. Redis fora do ar vira fala curta ao motorista, sem logar o erro do SDK.

## Passo 1 — a trava (primeiro commit; vale sozinho)

- `AgentTaskInput` ganha `driverId: string` (obrigatório). Orquestrador e A2A preenchem; nenhum agente aceita o campo vindo de fora.
- **Spotify** (`src/lib/spotify/auth.ts` e `src/agents/spotify/*`):
  - O token do servidor só é usado se `driverId === LEGACY_OWNER_DRIVER_ID`.
  - Motorista não dono usa só o token próprio (`driverContext.spotifyRefreshToken` ou cookie, que é dele até a entrega 4). Se falhar, **não** há fallback para o do servidor. Sem token próprio: fala "Conecte seu Spotify" (texto curto, sem detalhe técnico).
  - Os dois fallbacks cruzados atuais (custom → servidor e servidor → custom) saem.
  - Os caches de módulo (`cachedToken`, `rotatedRefreshToken`) só são lidos no caminho do dono.
- **Waze** (`src/lib/waze/address-book.ts`, `src/agents/waze/*`):
  - `getAddressBook()` global e `WAZE_SAVED_ADDRESSES` só para o dono.
  - `LayeredAddressBook` deixa de escrever no `baseBook`. A classe sai (ou vira leitura de semente sem `set` global).
  - `driverContext.savedAddresses` do cliente é **ignorado** pelo servidor.

## Passo 2 — endereços por motorista no Redis

- Nova abstração `AddressBook` por `driverId`, com `MemoryAddressBook` (testes) e `UpstashAddressBook`, seleção por `getAddressBook(driverId)`. Mesmo prefixo `finn:<env>:`, mesma regra de produção sem variáveis = falha fechada, mesmo `DriverStoreUnavailableError` genérico.
- Chave: `driver-addr:<driverId>` → hash `{ casa, trabalho }` (rótulos da lista fechada `SAVED_LABELS`).
- Valor: `trim`, 1 a 200 caracteres, sem caracteres de controle. Fora disso, rejeita e o agente pede de novo.
- Dono: lê Redis e, se vazio, a semente de `WAZE_SAVED_ADDRESSES` (somente leitura, nunca gravada de volta).
- Endereço é dado pessoal e fica em texto puro no Redis, sob chave do motorista (risco aceito; criptografia só se o dono pedir).
- O `save_address` (ClientAction) continua sendo emitido para não quebrar o PWA atual. A entrega 5 o remove.

## Passo 3 — A2A (M1, os 6 pontos)

| # | Ponto | Solução |
|---|---|---|
| 1 | De quem são os recursos | A2A roda como **dono, explícito**: `driverId = LEGACY_OWNER_DRIVER_ID` fixo no handler, documentado: `FINN_A2A_TOKEN` é credencial do dono. Nunca lido do corpo. |
| 2 | Livro global | Resolvido pelo passo 1: só o dono usa o livro com semente. |
| 3 | Limite de taxa | Redis (`ratelimit:a2a:<ip>`), antes de comparar o Bearer. 10 falhas por 600 s por IP; IP ausente ou inválido cai no balde `noip` de 3. 429 com `Retry-After`. Redis fora do ar = 503 (A2A é externo, sem voz). Padrões ajustáveis. |
| 4 | Rotação | Aceita `FINN_A2A_TOKEN` e, durante a troca, `FINN_A2A_TOKEN_NEXT` (ambos 64 hex, diferentes entre si e do `FINN_API_TOKEN`). Procedimento escrito em `docs/` (criar NEXT, redeploy, trocar o cliente, promover, apagar NEXT). Revogar = remover a variável e fazer redeploy. |
| 5 | `continuation` | Validada por parser estrito por agente (lista fechada; desconhecido é ignorado), tamanho máximo 2 KB. Não é assinada: sem autoridade própria, e o `driverId` vem do servidor, então não escala privilégio. Vale também em `/api/orchestrator`. |
| 6 | Artifact `result` | Para o cliente externo devolve só `{ agent, status, speech }`. Saem `toolCalls` (argumentos e resultados com endereços e URIs) e `clientActions` (deep links com endereço). |

## Variáveis (só nomes e formato)

| Nome | Formato | Quando |
|---|---|---|
| `FINN_A2A_TOKEN_NEXT` | 64 hex, opcional | só durante rotação |

`FINN_A2A_TOKEN` continua **não criada** nesta entrega. Criar depois do security-review aprovar o passo 3.

## Critério de pronto

- `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` passam; nenhum teste faz chamada de rede.
- Testes obrigatórios:
  - motorista B nunca lê endereço de A (Memory e Upstash com `fetch` falso);
  - motorista não dono nunca usa `SPOTIFY_REFRESH_TOKEN`, nem com o token próprio falhando, nem com cache do dono quente;
  - nenhuma escrita no livro global; semente do dono é só leitura;
  - `driverId` no corpo, no `driverContext` ou na `continuation` é ignorado (teste de rota);
  - `driverContext.savedAddresses` ignorado;
  - Redis fora do ar: fala curta, sem log do erro, sem cair no global;
  - A2A: 429 após o limite, balde `noip`, dois segredos na rotação, valores iguais rejeitados, `continuation` hostil ignorada, artifact sem `toolCalls` e `clientActions`;
  - chave sempre com prefixo de ambiente; produção sem variáveis falha fechada.
- Nenhum segredo ou endereço em log, erro ou snapshot.
- Relatório no formato da Seção 5, com "não verificado".
- Revisão: qa e security-review (Opus) uma vez sobre o diff estável. Área crítica.

## Execução

Um PR único empilhado sobre #4, com 3 commits na ordem acima (o passo 1 é revisável sozinho). `api` (Sonnet). Se o passo 3 crescer demais, vira PR próprio.

## Fora de escopo

Criptografia do refresh token e saída dele do `driverContext` (entrega 4); PWA (entrega 5); rate limit por motorista nas rotas de IA (M3); firewall e cota do Upstash (A3); rota de `purge` de dados do motorista (débito novo: `revokeDriver` não apaga endereços).

## Decisões embutidas (provisórias, ajustáveis)

1. A2A só do dono (recomendado) em vez de um `driverId` por cliente externo. Reabre se houver um cliente A2A de terceiros.
2. Endereços ditados no aparelho (`driverContext.savedAddresses`) deixam de valer: o dono pode precisar ditar casa e trabalho de novo uma vez, se hoje só estiverem no aparelho e não em `WAZE_SAVED_ADDRESSES`.
3. Texto puro no Redis para endereços.

## Histórico de mudanças

- 2026-10-27: rascunho.
