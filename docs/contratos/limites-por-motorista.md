# Contrato — limites por motorista nas rotas de IA (M3)

Status: **rascunho para aprovação do dono** (2026-10-28), com 4 decisões embutidas. Base: achado M3 de [`../revisoes/driver-session-routes-security-review.md`](../revisoes/driver-session-routes-security-review.md) e do security-review da entrega 3; pré-requisito da etapa 3 do plano ("rate limit e observabilidade antes do beta").

## Objetivo

Hoje `/api/orchestrator`, `/api/realtime/transcribe`, `/api/realtime/tts` e `/api/realtime/session` só checam `authorizeDriver`. Um convidado (ou um token de 90 dias vazado) consome cota de Neuralake, Groq e OpenAI sem teto; o corte depende de o dono notar e rodar `driver:revoke`/`driver:rotate`. Esta entrega põe um teto **por motorista e por rota**, vindo do `driverId` provado, nunca do corpo.

Esta entrega libera um dos três bloqueios de convites em produção (os outros: A3, firewall e alerta de cota do Upstash, ação do dono; smoke em preview).

## Invariantes

1. A chave do limite usa o `driverId` devolvido por `authorizeDriver`. Nunca corpo, cabeçalho, cookie ou `contextId`.
2. O limite roda **depois** da autenticação e **antes** de ler o corpo ou chamar qualquer serviço pago. Requisição sem sessão válida (401) não consome nem cria contador (isso é A3).
3. Toda requisição autenticada conta, inclusive a malformada (400/413). Um cliente em loop não escapa do teto por mandar lixo.
4. Estourar o teto nunca chama o serviço pago.
5. A resposta 429 não revela contagem, teto nem identidade; só o escopo (`burst` ou `day`).
6. Nenhum `console.*` com `driverId`, chave ou contagem. Só um aviso por estouro, com rota e escopo (observabilidade).

## Modelo

Dois tetos por rota e por motorista, os dois só no servidor:

- **Rajada** (antiloop): em memória da instância, janela fixa de 60 s. Não usa Redis. Protege contra loop de cliente com bug. Como as instâncias não compartilham memória, é um freio de melhor esforço, não um limite global.
- **Dia** (custo): contador no Redis (`incrementRateLimit`), janela por **dia de calendário em `America/Sao_Paulo`**. Esta é a garantia de custo.

| Rota | Classe | Rajada (por 60 s) | Dia |
|---|---|---|---|
| `POST /api/realtime/transcribe` | `stt` | 20 | 600 |
| `POST /api/orchestrator` | `orchestrator` | 20 | 600 |
| `POST /api/realtime/tts` | `tts` | 20 | 600 |
| `POST /api/realtime/session` | `live` | 5 | 30 |

Raciocínio: um turno de voz = 1 `stt` + 1 `orchestrator` (+ 1 `tts` se a voz do OpenAI estiver ligada). 600 por dia equivale a um turno a cada 20 s durante 3 horas, acima de qualquer viagem normal. `live` fica bloqueado por padrão (`ENABLE_GPT_LIVE`); o limite só roda depois dessa checagem, para a rota desligada não gastar contador.

- **Chave do dia**: `ratelimit:ai:<classe>:<AAAAMMDD>:<driverId>`, TTL de 90000 s (25 h, para cobrir a virada sem depender do relógio exato). Cabe no regex das chaves (`^ratelimit:[A-Za-z0-9:._-]{1,100}$`) com `driverId` de comprimento máximo; há teste para isso.
- **Um comando de Redis por requisição de IA** (`EVAL` do `incrementRateLimit`). O custo de cota do Upstash Free é este mais o que a autenticação já gasta.
- **Rajada**: mapa `driverId:classe` → `{ count, resetAt }`, no máximo 1000 entradas (varre as vencidas; ao encher, descarta as mais antigas). Sem timers.
- O dono tem os mesmos tetos (decisão embutida 4).

## Resposta ao estourar

`429`, `Cache-Control: no-store`, corpo `{ "error": "Too many requests", "scope": "burst" | "day" }`.

- `Retry-After`: rajada = segundos até o fim da janela de 60 s; dia = segundos até a meia-noite de São Paulo (o cliente já limita `Retry-After` a 3600 s e só usa o número para decidir o texto; não muda).
- O PWA já fala "Muitas tentativas, tente de novo em instantes." para qualquer 429. Para `scope === "day"` (comparação estrita), o PWA fala outro texto fixo: "Você atingiu o limite de uso de hoje. Volte amanhã." Qualquer outro valor de `scope`, ausente ou inválido cai no texto genérico. O texto nunca vem do servidor.

## Falha do Redis

- **Motorista com sessão `v1.`**: Redis fora = `503` "indisponível" (falha fechada; a autenticação já depende do mesmo store, então não piora a disponibilidade).
- **Dono** (`isOwner(driverId)`): Redis fora = **deixa passar** (falha aberta, só no teto de dia; a rajada em memória continua valendo). Motivo: com o id legado do dono a autenticação hoje não toca o Redis, e uma queda do Upstash não deve calar o app do carro do próprio dono. O risco é limitado ao crédito do dono e exige token do dono vazado **e** Redis fora (decisão embutida 3).

## Rotas fora do escopo

`POST /api/agents/[agent]` (A2A) já tem limitador próprio; `/api/session` e `/api/spotify/*` têm os seus. Falhas de Bearer sem sessão (força bruta de `FINN_API_TOKEN`) e qualquer limite por IP ficam com a A3 (firewall da Vercel); o `FINN_API_TOKEN` sai depois da virada.

## Variáveis

Nenhuma nova. Os tetos ficam em constantes num único módulo (`src/lib/ai-limits.ts`), alteráveis por PR.

## Critério de pronto

- `npm test`, `npm run typecheck`, `npm run lint` e `npm run build` passam; nenhum teste faz chamada de rede nem de serviço pago.
- Testes obrigatórios, por rota (as 4):
  - sem sessão: 401 e o contador **não** é tocado; token legado do dono mapeia para o dono e é contado como dono;
  - dentro do teto passa e chega ao serviço (stub); no teto + 1 dá 429 com `scope`, `Retry-After` e **sem** chamar o serviço;
  - rajada e dia são independentes: estourar um não zera o outro; `scope` reflete qual estourou; se os dois estouram, `scope: "day"`;
  - motoristas A e B têm contadores separados (A estourado não afeta B); a chave usa o `driverId` da autenticação mesmo com `driverId`, `contextId` ou cabeçalho forjado no corpo;
  - contagem inclui corpo inválido (400) e grande demais (413);
  - a virada do dia: no fim do dia de São Paulo o contador muda de chave (relógio injetado); `Retry-After` do dia bate com a meia-noite local;
  - chave com `driverId` de comprimento máximo é aceita pelo regex; `driverId` ou classe com caractere inválido nunca vira chave;
  - Redis fora: motorista 503 sem chamar o serviço; dono passa; nenhuma saída de log contém `driverId`, chave ou contagem (varredura que expande message, stack e cause);
  - `/api/realtime/session` desligada (`ENABLE_GPT_LIVE` != 1) responde 403 **sem** tocar no contador;
  - o mapa em memória nunca passa de 1000 entradas e entradas vencidas somem;
  - mutações a provar: remover o limite de uma rota derruba teste; trocar a chave por `contextId` derruba teste; inverter a ordem (limite antes de `authorizeDriver`) derruba teste; falhar aberto para motorista derruba teste; fazer o 429 chamar o serviço derruba teste.
- PWA (`web`): `failure-speech` fala o texto do dia só para `scope === "day"` (teste com `scope` ausente, inválido, objeto, "DAY", " day"); o `Retry-After` continua com o teto de 3600 s; `tests/MANUAL.md` ganha o caso.
- `docs/ARCHITECTURE.md` (tabela de rotas) e `docs/ESTADO_ATUAL.md` (M3 resolvido, tetos e como mudá-los).
- Relatório no formato da Seção 5, com "Não verificado".
- Revisão: qa e security-review (Opus), uma vez, sobre o diff estável. Área crítica (acesso ao Redis com dado de motorista e caminho de autenticação). qa só muta numa cópia fora do repositório.

## Execução

Branch `feat/ai-rate-limits`, empilhada sobre `fix/expire-legacy-spotify-cookie` (PR #9), PR #10. Dois commits de código: (1) servidor, pelo `api` (Sonnet): `src/lib/ai-limits.ts` e as 4 rotas; (2) PWA, pelo `web` (Sonnet): `failure-speech` e `tests/MANUAL.md`. Os agentes não rodam ao mesmo tempo na árvore. Fora do escopo do `api`: `src/components/**` e `src/lib/voice/**`; do `web`: `src/app/api/**`.

## Fora de escopo

Limite por IP e força bruta de Bearer (A3), custo por token ou por segundo de áudio (o teto é por requisição), métricas e painel (etapa 3 do plano), limite global somado de todos os motoristas, rajada compartilhada entre instâncias, cobrança ou cota configurável por motorista.

## Decisões embutidas (provisórias, ajustáveis)

1. **Tetos**: rajada 20/min e dia 600 (5/min e 30 por dia no `live`). Raciocínio acima; ajuste por PR depois de ver o uso real.
2. **Dia de calendário de São Paulo** em vez de janela móvel de 24 h: o motorista entende "volte amanhã" e o `Retry-After` é exato; o pior caso é o dobro do teto numa virada de meia-noite.
3. **Dono falha aberto** no teto de dia quando o Redis cai; motorista falha fechado.
4. **O dono também é limitado** (mesmos tetos): o token do dono é o mais valioso para vazar.

## Histórico de mudanças

- 2026-10-28: rascunho.
