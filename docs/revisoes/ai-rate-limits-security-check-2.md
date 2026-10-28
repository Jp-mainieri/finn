# Checagem pontual de segurança: rodada de correções do M3

- Branch: `feat/ai-rate-limits`. Diff revisado: `git diff a48f906 HEAD` (8 commits, c3b4836 no topo). Código de produção alterado: `src/lib/ai-limits.ts`, `src/app/api/agents/[agent]/route.ts`, `src/app/api/orchestrator/route.ts`, `src/app/api/realtime/transcribe/route.ts` e `src/lib/voice/stt-tts-session.ts`.
- Contexto lido: o contrato `docs/contratos/limites-por-motorista.md` (até a linha 101 do Histórico), a revisão anterior `docs/revisoes/ai-rate-limits-security-review.md` e as seções "Rodada de correções" dos dois relatórios.
- Revisor: security-review (Opus), 2026-10-28. Só leitura: nenhum código editado, nenhuma mutação, nenhum commit. Este é o único arquivo criado. **Este relatório não aprova o merge.**

## Resumo

Não há achado crítico nem alto. As correções fazem o que prometem:
- o A2A agora tem teto e ele roda depois de `guardA2A`;
- `Object.hasOwn` fecha as classes vindas do protótipo;
- a falha aberta do dono passou a depender do tipo do erro;
- `transcript` e áudio têm teto antes do serviço pago;
- o aviso de log é limitado e não carrega dado sensível;
- a guarda do PWA não cria corrida.

Sobram 1 achado médio e 6 baixos. O médio: o teto de áudio é em bytes e o servidor aceita qualquer codec. Com áudio comprimido, 1 MB ainda dá minutos de áudio por requisição, e isso anula a calibração "pelo que o PWA envia".

| # | Sev. | Título | Onde |
|---|---|---|---|
| N1 | Médio | O teto de áudio é em bytes, mas o `mimeType` e o nome do arquivo vêm do cliente: em opus/webm, 1 MB dá vários minutos por requisição | `src/app/api/realtime/transcribe/route.ts:10,70,76,84-85,101,109-110` |
| N2 | Baixo | O `transcript` do A2A não tem teto de tamanho (o do orquestrador tem 2000) | `src/lib/a2a-server.ts:49,57-63,81` |
| N3 | Baixo | O A2A herda a falha aberta do dono no contador do dia, enquanto `guardA2A` falha fechado por desenho | `src/lib/ai-limits.ts:164`, `src/app/api/agents/[agent]/route.ts:17`, `src/lib/auth.ts:98,119-121` |
| N4 | Baixo | Resíduo do B1: credencial do Upstash errada ou revogada também vira `DriverStoreUnavailableError`, e o dono com id legado fica sem teto de dia | `src/lib/driver/upstash-store.ts:140-147`, `src/lib/ai-limits.ts:164` |
| N5 | Baixo | O log limitado perde o volume de estouros: 1 ou 10 mil 429 por minuto dão a mesma linha | `src/lib/ai-limits.ts:110-121` |
| N6 | Baixo | O corpo do contrato contradiz o Histórico (linha 25, "garantia de custo"; linha 55, "A2A já tem limitador próprio"; tabela sem `a2a`) | `docs/contratos/limites-por-motorista.md:25,27-32,55` |
| N7 | Baixo | O corpo é lido inteiro antes do teto (JSON sem `content-length`, base64 decodificado antes de medir): custa só memória e CPU, nunca o serviço pago | `src/app/api/orchestrator/route.ts:20`, `src/app/api/realtime/transcribe/route.ts:19-20,60,72,89` |

---

## Pontos pedidos, um a um

### (1) A2A

Todos os itens abaixo são Fato, conferidos no código.

- **Ordem.** A rota chama `guardA2A` (`route.ts:11-12`), depois resolve o dono (l.15-16), depois `enforceAiLimit("a2a", owner)` (l.17-18). Só então lê `ctx.params`, faz `getAgent` (l.20-22) e chama `handleA2ARequest` (l.23), que é onde o corpo é lido (`a2a-server.ts:49`). O limite roda antes do corpo e antes do agente. Um agente desconhecido (404) e um corpo malformado também contam (invariante 3). Isso está testado em `tests/acceptance/ai-limits-a2a-inputs.test.ts:128`.
- **401 e falhas do guard não criam contador.** `guardA2A` responde antes do limite em todos os casos de falha:
  - configuração ausente ou sem dono: 503 (`auth.ts:105-106`);
  - Bearer ausente ou fora do formato: 401 (`auth.ts:108-109`);
  - IP bloqueado: 429 (l.118);
  - Redis fora: 503 (l.119-121);
  - segredo errado: 401 (l.133-138);
  - dono revogado: 503 (l.127-130).

  Teste em `ai-limits-a2a-inputs.test.ts:84`.
- **Sem dono: 503 sem contador.** O primeiro corte é `guardA2A` (`auth.ts:106`). O `if (!owner)` da rota (l.16) é uma segunda trava redundante, e também fica antes do contador.
- **Nenhum caminho novo de autenticação.** O diff só acrescenta código depois de `if (denied) return denied`. O `driverId` do limite vem de `getOwnerDriverId()`, que lê só o ambiente, nunca a requisição. A chave é `ratelimit:ai:a2a:<dia>:<dono>`, que não colide com a do limitador de falhas `ratelimit:a2a:<ip>` (o segundo segmento é diferente).
- **Contador separado do orquestrador: o dono gasta o dobro?** Sim. O dono tem 600 por dia em `orchestrator` e mais 600 em `a2a`, além de `stt` e `tts`, que já eram classes separadas. Considero aceitável:
  - o A2A usa outra credencial (`FINN_A2A_TOKEN`), então um token vazado dá acesso a 600 por dia, não a 1200;
  - uma chamada A2A executa um agente só, enquanto o orquestrador faz fan-out para vários, então custa menos;
  - a decisão 4 do contrato já trata o dono com os mesmos tetos por classe.

  Compartilhar o contador `orchestrator` faria o A2A, com um token externo, conseguir calar a voz do carro do dono, o que é pior. Ver N2 e N3 para os resíduos.

### (2) Regex de classe e `Object.hasOwn`

Fato:
- `CLASS_RE = /^[a-z0-9]{1,20}$/` (`ai-limits.ts:72`) e `Object.hasOwn(AI_LIMITS, cls)` (l.76).
- As chaves próprias de `AI_LIMITS` são `stt`, `orchestrator`, `tts`, `live` e `a2a` (l.18-25). `constructor`, `toString`, `hasOwnProperty` e `valueOf` casam a regex, mas não são próprias, então a função lança e responde 503.
- `__proto__` já falha na regex (sublinhado). Teste com as 5 em `tests/acceptance/ai-limits.test.ts`, bloco "class %s is never a limit class": 503, nenhum incremento e mapa de rajada vazio.
- `aiDayKey` roda antes de `burstHit` (l.147-156), então uma classe inválida não cria entrada na rajada nem lê `AI_LIMITS[cls]`.
- Nenhuma classe é forjável pelo cliente: as 5 chamadas de `enforceAiLimit` passam literais tipados, e nada da requisição chega a `cls`.
- A chave continua sendo só `ratelimit:ai:<classe>:<AAAAMMDD>:<driverId>` (l.79). O caso mais longo (`orchestrator`) tem o mesmo tamanho medido na revisão anterior, dentro do `RATE_KEY_RE`.
- `AI_LIMITS` não está congelado em tempo de execução (`Readonly` só existe no TypeScript). `grep` não encontrou nenhuma escrita fora do módulo.

### (3) Falha aberta do dono só com `DriverStoreUnavailableError`

Fato:
- **Store não configurado:** `resolveDriverBackend` lança um `Error` comum (`src/lib/driver/index.ts:29`), e `getDriverStore()` é chamado dentro do `try` (`ai-limits.ts:160`). O erro não é do tipo esperado, então o dono recebe 503.
- **Erros de validação** (`validateWindowSeconds`, `store.ts:170-172`; `keys.rateLimit`) também são `Error` comum e dão 503. Teste com `Error`, `TypeError` e `RangeError` para o dono, mais `Error` e `DriverStoreUnavailableError` para o motorista, todos 503 (`ai-limits.test.ts`, "any other error from the counter...").
- **"Segredo ausente":** o caminho do contador não usa segredo. `FINN_SESSION_SECRET` só afeta `authorizeDriver` (503 antes do limite) e `FINN_INVITE_PEPPER` não é usado por `incrementRateLimit`.
- **`instanceof` entre bundles:** a classe é definida uma única vez, em `src/lib/driver/store.ts:129`. `ai-limits.ts:13` a importa por `@/lib/driver`, que a reexporta (`index.ts:7`), e `upstash-store.ts:2` a importa de `./store`. É o mesmo módulo no mesmo grafo. Se um dia houver cópia duplicada, `instanceof` dá `false` e o código cai no ramo de 503: falha fechada, que é a direção segura. O inverso, um erro qualquer passar por `DriverStoreUnavailableError`, não acontece com `instanceof`. Não conferi a saída do build (ver "Não verificado").
- **Resíduo:** o wrapper `call()` (`upstash-store.ts:140-147`) transforma **qualquer** falha do cliente Redis em `DriverStoreUnavailableError`. Isso inclui credencial errada ou revogada e URL errada. Ver N4.

### (4) Tetos de entrada

Fato:
- **`transcript`.** Passa por `trim` (`orchestrator/route.ts:29`), depois a checagem `> 2000` dá 400 (l.34-36), antes de `orchestrate` (l.41). O limite (l.15) roda antes do corpo, então o 400 conta. Testes em `ai-limits-a2a-inputs.test.ts:135,144,149`. O tamanho é medido em unidades UTF-16, o que basta para custo.
- **Áudio em JSON.** O tamanho real é o do buffer decodificado (`transcribe/route.ts:72,76`), e passar do teto dá 413 antes de `fetch` (l.126).
- **Áudio em multipart.** O tamanho real é `field.size` (l.101).
- **`content-length`.** É só um corte antecipado (l.19-20). Ausente ou não numérico vira 0 ou `NaN` e passa, mas a checagem real vem depois. Os casos de `content-length` mentiroso e de ausência estão testados (`ai-limits-a2a-inputs.test.ts:178,185,192,197`). O 413 conta (l.202).
- **Caminho sem teto até o serviço pago:** não existe. Todo caminho que chega ao `fetch` passou por `buffer.length` ou `field.size` ≤ 1 MB. `application/x-www-form-urlencoded` produz uma string, não um `Blob`, e dá 400 (l.95).
- **Leitura do corpo sem teto:** existe, mas só custa memória. Ver N7.
- **O teto de bytes não limita a duração.** Ver N1.

### (5) Aviso de log limitado

Fato:
- O texto é `[ai-limit] <classe> <frase fixa>` (`ai-limits.ts:120`). `cls` é uma das 5 classes (validada em l.149 antes de qualquer aviso) e `what` é uma de 3 frases fixas. Não leva `driverId`, chave nem contagem. Os testes varrem `driverId` e `ratelimit:` nos logs.
- O mapa `lastWarn` tem no máximo 5 × 3 = 15 chaves, todas derivadas de constantes, e nunca cresce com a entrada do cliente.
- **Detecção de abuso:** os logs nunca identificaram o motorista, então a limitação não esconde *quem* estourou. Ela esconde *quanto*: ver N5. O aviso "day counter unavailable" do dono continua saindo, uma vez por minuto por instância, enquanto a falha durar. É sinal suficiente para notar a falha aberta.

### (6) PWA: guarda `closed`/`reqId` em `stt-tts-session`

Fato:
- **Ordem do código.** A nova linha (`stt-tts-session.ts:323`) retorna depois de `classifyServerFailure` e antes de `speakLocal` e de `onError`.
- **Estado.** O `finally` (l.380-385) continua rodando:
  - `transcribing` só é zerado quando a requisição ainda é a atual, e a mais nova zera o próprio;
  - `onWorkFinished` é sempre chamado, pareado com `onWorkStarted` (l.300).

  Nenhum estado fica preso.
- **Texto do servidor.** Nenhum texto do servidor é falado: `speakLocal` recebe só `LOCAL_SPEECH[...]`.
- **Corpo.** O corpo é lido só no 429, com teto de 1 KB e `cancel()` dentro de `classifyServerFailure` (sem mudança). Não vai para log nem para o DOM.
- **Corrida.** Uma requisição antiga substituída por uma nova fica muda. A nova fala, se também receber 429. Não há fala dupla nem perdida de forma relevante.
- **Testes.** Os 4 casos novos estão em `stt-tts-session.test.ts`: sessão fechada durante o corpo, sessão fechada no prazo, sessão aberta com corpo tardio e servidor rápido.

### (7) Regressão dos achados anteriores

| Achado | Estado | Evidência |
|---|---|---|
| M1 (rajada ainda gasta 1 comando do Upstash na autenticação) | **Aberto**, aceito como dependência da A3 | Sem mudança no código. Está registrado no contrato (Histórico, item 7) e em `docs/ESTADO_ATUAL.md:78` (o firewall deve cobrir `/api/orchestrator`, `/api/realtime/*` e `/api/agents/*`, com alerta do Upstash). |
| M2 (custo por requisição sem teto) | **Parcialmente fechado** | `transcript` ≤ 2000: fechado. Áudio de 10 MB para 1 MB: ver N1 (bytes não são duração). Fallback duplo do TTS (OpenAI `tts-1`, Google): **não tratado**, `src/app/api/realtime/tts/route.ts` fora do diff. A frase "garantia de custo" do contrato (l.25) continua (N6). |
| M3 (A2A sem teto de custo) | **Fechado no código** | `route.ts:15-18` e o item (1) acima. O texto da linha 55 do contrato continua errado (N6). O tamanho da entrada do A2A ficou sem teto (N2). Ligar o A2A ainda depende das outras regras de `docs/ESTADO_ATUAL.md:43`. |
| B1 (falha aberta com qualquer exceção) | **Fechado**, com resíduo | `ai-limits.ts:164`. Store não configurado e erros de validação dão 503 para o dono. Resíduo: N4 (credencial do Upstash errada). |
| B2 (`in` aceita protótipo) | **Fechado** | `ai-limits.ts:76`, testes com 5 nomes do protótipo. |
| B3 (`--max-uses N` multiplica a cota) | **Aceito e documentado** | Contrato (Histórico, item 8) e `docs/ESTADO_ATUAL.md:78` ("um convite por convidado"). O padrão continua 1 uso, sem mudança no código. |
| B4 (uma linha por 429) | **Fechado** | `ai-limits.ts:110-124`. Resíduo informativo: N5. |

---

## Achados novos

### N1 (médio): o teto de áudio é em bytes, mas o codec é escolhido pelo cliente

**Fato.**
- `MAX_AUDIO_BYTES = 1 MB` (`transcribe/route.ts:10`) foi calibrado para WAV de 16 kHz, mono, 16 bits (32 KB/s), que é o que o PWA envia (`stt-tts-session.ts:290-292`, sempre `"audio/wav"`).
- O servidor aceita qualquer `mimeType` em JSON (l.70) e troca o nome do arquivo enviado ao provedor para `.webm` ou `.m4a` (l.84-85).
- Em multipart, o servidor repassa o nome do arquivo escolhido pelo cliente (l.109-110).
- Nada confere se o conteúdo é WAV, nem a taxa ou a duração.

**Cenário.** Um convidado com sessão válida, ou um token vazado, envia `{ audio: <opus/webm>, mimeType: "audio/webm" }` com cerca de 1 MB. Em opus a 12 a 16 kbps, isso dá entre 8 e 11 minutos de áudio por requisição, contra 15 s no PWA real, ou seja, cerca de 30 a 45 vezes o raciocínio do contrato. Com 600 requisições por dia, são dezenas de horas de transcrição por dia por motorista, vezes até 26 motoristas.

**Hipótese (custo).** A ordem de grandeza é de dólares por dia por motorista no Groq e de dezenas de dólares no `gpt-4o-mini-transcribe`. Os preços e o limite de duração de cada provedor não foram verificados.

**Recomendação (antes dos convites; a decisão é do dono, como no M2).**
- Aceitar só `audio/wav`, porque o PWA não envia outro formato.
- Validar o cabeçalho RIFF/WAVE (PCM, 16 kHz, mono, 16 bits) e calcular a duração pelo tamanho do chunk `data` dividido pela taxa de bytes, com teto de cerca de 16 a 20 s.
- Enviar ao provedor sempre o nome fixo `audio.wav`.

Testes: webm de 1 MB dá 400 ou 415; WAV com taxa de amostragem baixa (8 kHz, mais duração por byte) também é barrado pela duração.

### N2 (baixo): o `transcript` do A2A não tem teto

**Fato.** `handleA2ARequest` junta todas as partes de texto (`a2a-server.ts:57-63`) e passa o resultado inteiro para `agent.handle` (l.81). A rodada pôs 2000 caracteres no orquestrador, mas não no A2A, que "espelha o orquestrador" (comentário em `ai-limits.ts:23`).

**Cenário.** Quando `FINN_A2A_TOKEN` existir, um token vazado faz 600 chamadas por dia com entradas do tamanho máximo do corpo da plataforma: o mesmo problema do M2 que a rodada fechou no orquestrador.

**Recomendação.** Aplicar o mesmo teto de 2000 caracteres em `handleA2ARequest` (erro JSON-RPC -32602), antes de criar `FINN_A2A_TOKEN`. Isso não bloqueia convites.

### N3 (baixo): o A2A herda a falha aberta do dono

**Fato.** `enforceAiLimit("a2a", owner)` usa `isOwner(owner)`, que é sempre verdadeiro no A2A. Com `DriverStoreUnavailableError` no `EVAL`, a requisição passa sem teto de dia (`ai-limits.ts:164`). O motivo do contrato para essa falha aberta é não calar o app do carro do dono (contrato:51), e ele não vale para o A2A. O próprio `guardA2A` documenta "Redis down is 503 (A2A is external, there is no voice to speak to)" (`auth.ts:98`).

**Cenário.** A janela é estreita: `guardA2A` acabou de fazer um `GET` no Redis com sucesso (l.118), e o `getDriver` também, se o dono for real. Sobra a falha parcial, em que o `EVAL` dá timeout e o `GET` funciona. Durante essa falha, um token A2A vazado tem só a rajada (20 por minuto por instância).

**Recomendação.** Fazer a classe `a2a` falhar fechado sempre, por exemplo com `failOpenForOwner: cls !== "a2a"`, e testar: `DriverStoreUnavailableError` no contador do A2A dá 503 sem chamar o agente. Fazer isso antes de criar `FINN_A2A_TOKEN`.

### N4 (baixo): resíduo do B1, credencial do Upstash errada conta como "indisponível"

**Fato.** `UpstashDriverStore.call()` (`upstash-store.ts:140-147`) converte qualquer exceção do cliente Redis em `DriverStoreUnavailableError`. Isso inclui 401 por token revogado, URL errada e DNS. Agora só a variável **ausente** dá 503 para o dono. Variável **errada** ainda abre o teto de dia do dono.

**Cenário.** Com o token legado ligado e sem `FINN_OWNER_DRIVER_ID` (estado atual, segundo `docs/ESTADO_ATUAL.md:18`), a autenticação do dono não toca no store (`auth.ts:184`). Um `KV_REST_API_TOKEN` rotacionado no painel do Upstash sem atualizar a Vercel deixa o dono sem teto de dia até alguém notar. Nesse cenário os motoristas `v1.` já estão em 503, o que torna a falha visível. O aviso sai uma vez por minuto. O risco se limita ao crédito do dono e exige o token legado vazado.

**Recomendação.** Aceitável até a virada do dono, porque com `FINN_OWNER_DRIVER_ID` real a autenticação já dá 503. Registrar como débito. Opcional: separar no `call()` o erro de autenticação do Upstash, se o cliente o expuser de forma confiável. Não verifiquei se expõe.

### N5 (baixo): o log limitado perde o volume

**Fato.** Uma linha por classe e escopo por minuto, por instância (`ai-limits.ts:110-121`), sem contagem (a invariante 6 proíbe contagem por motorista). Um estouro isolado e um loop de 10 mil requisições por minuto aparecem iguais nos logs.

**Cenário.** O M1 (cota do Upstash esgotada por loop) não aparece nos logs pelo volume. A detecção depende do alerta de uso do Upstash, que ainda não existe (A3), e das métricas de status por rota da Vercel. A existência dessas métricas no plano atual não foi verificada.

**Recomendação.** Aceitar, com a condição de que o alerta do Upstash seja criado junto com a A3. Opcional: acrescentar à linha o número de avisos suprimidos no minuto anterior, que é agregado da instância, sem `driverId` nem contagem por motorista. Verificar com o dono se isso é compatível com a invariante 6.

### N6 (baixo): o corpo do contrato contradiz o Histórico

**Fato.**
- `docs/contratos/limites-por-motorista.md:25` ainda diz que o dia "é a garantia de custo".
- A tabela (l.27-32) não tem a classe `a2a`.
- A linha 55 ainda diz que o A2A "já tem limitador próprio".
- Só o Histórico (l.101) corrige esses pontos.

**Cenário.** Quem ler só o corpo do contrato, por exemplo na hora de ligar o A2A, chega à conclusão errada que o M3 apontou.

**Recomendação.** Corrigir as três passagens no corpo do contrato (tarefa do `docs-sync`).

### N7 (baixo): o corpo é lido sem teto antes da checagem

**Fato.**
- `/api/orchestrator` não confere `content-length` e chama `request.json()` direto (`orchestrator/route.ts:20`).
- `/api/realtime/transcribe` deixa passar um corpo sem `content-length` (l.19-20).
- No transcribe, `Buffer.from(base64)` decodifica a string inteira antes de medir (l.72), e `formData()` (l.89) também lê tudo.

**Cenário.** O efeito é só memória e CPU por requisição, limitadas pelo teto de corpo da plataforma (hipótese: 4,5 MB na Vercel). Nada chega ao serviço pago, e a requisição já foi contada.

**Recomendação.** Opcional: em JSON, recusar `raw.length > ceil(MAX_AUDIO_BYTES * 4 / 3) + 64` antes de decodificar, e pôr um corte por `content-length` no orquestrador (por exemplo, 16 KB).

---

## Comandos rodados

- `git log --oneline a48f906..HEAD`, `git diff --stat a48f906 HEAD`, `git diff a48f906 HEAD -- src/ ':!*.test.ts'` e `grep` por `DriverStoreUnavailableError`, `contextId`, `AI_LIMITS` e `MAX_UTTERANCE_MS`.
- `npx vitest run --no-cache tests/acceptance/ai-limits.test.ts tests/acceptance/ai-limits-a2a-inputs.test.ts src/lib/voice/stt-tts-session.test.ts src/lib/voice/live-session.test.ts src/lib/voice/voice-controller.test.ts src/lib/voice/failure-speech.test.ts`: **6 arquivos, 192 testes passaram, 0 falharam.** `git status --porcelain` estava vazio antes e depois.
- Não rodei o lote completo (`npm test && npm run typecheck && npm run lint`), o build nem mutações. As mutações são tarefa do qa, numa cópia fora do repositório.

## Não verificado

- A saída do build (Turbopack/webpack): se `DriverStoreUnavailableError` fica em um único módulo por rota. A análise mostra que, se houver duplicação, o efeito é falha fechada.
- O Upstash real: `EVAL`, erro de credencial e se o cliente distingue erro de autenticação (N4).
- O limite real de corpo da Vercel (N7), as métricas de status por rota no plano atual (N5), o número de instâncias e a rajada efetiva.
- Preços e limites de duração do Groq e da OpenAI para opus/webm (N1). A conta de minutos por MB é estimativa por taxa de bits.
- O áudio real do iPhone (o teto de 1 MB vem do cálculo do formato, não de captura).
- Se `FINN_A2A_TOKEN` está mesmo ausente na Vercel (usei `docs/ESTADO_ATUAL.md:43`).
- O fallback duplo do TTS (resto do M2), que não foi reexaminado além de confirmar que está fora do diff.

## Isto bloqueia convites em produção?

**Nada do M3, por si, bloqueia convites.** Não há achado crítico nem alto, e as correções da rodada estão no código e testadas. O que pesa antes de abrir convites:

- **N1 (médio):** recomendo restringir o `transcribe` a WAV com teto de duração antes dos convites. É o mesmo tipo de decisão do M2, então cabe ao dono. Sem isso, o teto de 1 MB não limita o custo de STT como a rodada pretendia.
- **M1** continua dependendo da A3, que já é bloqueio de convites por si (firewall cobrindo as três famílias de rota e o alerta de cota do Upstash).
- **N2 e N3** bloqueiam ligar o A2A (criar `FINN_A2A_TOKEN`), não os convites.
- **N4 a N7** podem ficar como débito depois do merge.
