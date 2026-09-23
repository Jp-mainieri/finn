# Finn — arquitetura do código

Spec completa: "Finn — Especificação Técnica (MVP)". Este doc descreve **como o código está organizado** e **quem é dono de quê** nas frentes paralelas.

## Fluxo de um turno

```
PWA (Porcupine "Finn" → WebRTC GPT-Live-1)
  └─ evento de delegação (client) com a transcrição
       └─ POST /api/orchestrator { transcript, contextId }
            ├─ classify()  — palavra-chave, sem LLM; checa cada domínio independente
            ├─ fan-out Promise.all → spotifyAgent.handle() / wazeAgent.handle()   (in-process)
            │     └─ runToolLoop(): Neuralake /chat/completions + tools → executores reais
            └─ aggregate() → { speech, clientActions, results }
  PWA executa clientActions (abre deep link do Waze) e devolve `speech` ao Live-1
```

Os agentes também são expostos via A2A (JSON-RPC `message/send`) para chamadas externas:

| Rota | O quê |
| --- | --- |
| `POST /api/orchestrator` | Entrada do PWA (`OrchestratorRequest` → `OrchestratorResponse`) |
| `POST /api/agents/{spotify,waze}` | Endpoint de task A2A |
| `GET /agents/{spotify,waze}/.well-known/agent.json` | Agent Card (rewrite → `/api/agents/[agent]/card`) |

## Contratos (congelados — mudanças só na integração)

- `src/lib/contracts/a2a.ts` — `Agent`, `AgentTaskInput`, `AgentResult`, `AgentCard`, wire format A2A
- `src/lib/contracts/tools.ts` — schemas das 4 tools (verbatim da spec) + tipos dos argumentos
- `src/lib/contracts/client-events.ts` — `ClientAction`, `OrchestratorRequest/Response`
- `src/lib/contracts/neuralake.ts` — `NeuralakeClient` (compatível OpenAI)

Infra compartilhada (também não mexer nas frentes; se precisar, anote no relatório):
`src/lib/agent-runtime.ts` (`runToolLoop`, `UserFacingError`), `src/lib/a2a-server.ts`,
`src/lib/neuralake/*`, `src/lib/env.ts`, `src/orchestrator/*`, `src/agents/registry.ts`.

## Posse por frente (worktrees)

| Branch | Pode criar/alterar |
| --- | --- |
| `feat/spotify-agent` | `src/agents/spotify/**`, `src/lib/spotify/**`, `src/app/api/spotify/**` |
| `feat/waze-agent` | `src/agents/waze/**`, `src/lib/waze/**` |
| `feat/pwa-voice` | `src/app/page.tsx`, `src/app/layout.tsx`, `src/app/manifest.ts`, `src/app/globals.css`, `src/components/**`, `src/lib/voice/**`, `src/app/api/realtime/**`, `public/**` |

Cada frente pode adicionar env vars em `.env.example` **apenas na sua seção** e dependências no `package.json` (conflito de lockfile resolve-se na integração).

Regras para cada agente:
- Exportar `xxxAgent: Agent` de `src/agents/<id>/index.ts` (o registry já importa).
- Usar `runToolLoop` + `getNeuralakeClient()`; falha que o motorista deve ouvir → `throw new UserFacingError("frase curta")`.
- Resultado nunca carrega detalhe técnico em `speech`.

## Pendências conhecidas

- **Memória da Neuralake**: o mecanismo (campo/header) para memória por agente e Cross Memory não está documentado publicamente. `CompletionRequest.memoryScope` abstrai isso; o `HttpNeuralakeClient` ainda não envia nada (TODO `neuralake-memory`).
- **Suporte a `tools`** na Neuralake assumido idêntico ao da OpenAI — validar com a chave real.

## Dev

```bash
cp .env.example .env.local   # FINN_USE_MOCKS=1 roda tudo sem chaves
npm run dev
npm test && npm run typecheck && npm run lint
```
