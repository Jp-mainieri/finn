# Finn — Arquitetura de Personalização, Learning & Memória de Baixa Latência

**Data:** 22 de Outubro de 2026  
**Status:** Especificação de Evolução (Pós-MVP / Fase Beta)

---

## 1. Visão Geral e Premissa de Latência

Para que o **Finn** deixe de ser apenas um executador de comandos e se torne um **copiloto automotivo inteligente**, ele precisa aprender continuamente com cada motorista: seus destinos recorrentes, apelidos de playlists, horários de rotina e contexto recente da conversa.

### Premissa Inegociável: Orçamento de Latência (~0ms a 15ms)
No carro, qualquer acesso a banco de dados tradicional no caminho crítico (*hot path*) que adicione 150ms–300ms degrada a experiência de voz. Por isso, a arquitetura de dados do perfil do motorista segue o padrão **Local-First + Edge Cache (Redis) + Background Write-Behind**:

```
[PWA no Celular (Cache L1: localStorage / IndexedDB — 0ms)]
        │  Envia snapshot leve no DriverContext + driverId
        ▼
[Vercel Function em gru1 (São Paulo)]
        ├─► Leitura Hot-Path: Cache L1 (payload) ou Cache L2 (Upstash Redis em gru1: ~3-8ms)
        ├─► Execução Paralela dos Agentes (Spotify / Waze) + Fast-Speech
        ├─► Resposta Imediata de Voz ao Motorista
        └─► Pós-Resposta (waitUntil / Background Assíncrono — 0ms de impacto no motorista):
              └─► Atualiza Redis (histórico de hábitos, contadores, rotina) + Memória Neuralake
```

---

## 2. Arquitetura de Armazenamento e Cache (Redis + Banco/Neuralake)

### Identidade do Motorista (`driverId`)
- **Chave Primária Natural:** O próprio `spotify_user_id` obtido automaticamente quando o motorista conecta seu Spotify via OAuth (ou um `UUID` gerado no dispositivo caso ainda não tenha conectado o Spotify).
- Isso evita criar telas de cadastro/senha tradicionais e já vincula o perfil do motorista em qualquer aparelho.

### Camadas de Persistência
1. **L1 — Dispositivo (PWA `localStorage`):**
   - Guarda o snapshot ativo do `DriverProfile`. É enviado junto no `OrchestratorRequest.driverContext`, garantindo **0ms** de leitura mesmo no primeiro turno.
2. **L2 — Cache de Borda / Baixa Latência (Redis — ex: Upstash Redis na região `gru1` São Paulo):**
   - Tempo de resposta dentro da função Vercel em `gru1`: **~2ms a 8ms**.
   - Guarda o perfil completo (`finn:profile:<driverId>`), o histórico de turnos da viagem atual com TTL de 2 horas (`finn:trip:<contextId>`) e os contadores de frequência por horário (`finn:habits:<driverId>`).
3. **L3 — Memória Semântica / Longo Prazo (Neuralake Memory / Postgres opcional):**
   - Alimentada de forma **100% assíncrona** (usando `waitUntil()` do Next.js/Vercel após a resposta HTTP já ter sido entregue ao motorista), garantindo que o aprendizado nunca atrase a fala do Finn.

---

## 3. Camadas de Evolução de Learning & Personalização

### Camada 1: Memória Implícita de Hábitos, Lugares e Apelidos (Curto Prazo)

#### 1.1. Lugares Pessoais Dinâmicos no Waze (Além de Casa e Trabalho)
- **Hoje:** Suporta apenas os rótulos fixos `casa` e `trabalho`.
- **Evolução:** O `AddressBook` do motorista passa a ser um dicionário aberto `Record<string, SavedPlace>`:
  - Suporta qualquer rótulo falado pelo motorista: *"academia"*, *"casa da minha mãe"*, *"faculdade"*, *"casa da namorada"*, *"escritório do centro"*.
  - **Fluxo de Aprendizado:**
    1. Motorista diz: *"Me leva pra academia"*.
    2. O `waze-agent` vê que `"academia"` não está no perfil e pergunta: *"Qual é o endereço da academia?"*.
    3. Motorista responde o endereço → o Finn abre o Waze e salva `"academia"` no Redis + dispositivo. Da segunda vez em diante, vai direto sem perguntar.

#### 1.2. Aliases Musicais e Ranking de Playlists no Spotify
- **Preferências e Apelidos (`playlistAliases`):**
  - Se o motorista pede *"toca música pra dirigir"* ou *"toca meu treino"* e escolhe/confirma a playlist `"Drumz 🥁🗯️"`, o perfil associa automaticamente o termo `"treino"` → `"Drumz 🥁🗯️"`.
- **Frequência de Reprodução (`topPlaylists`):**
  - Cada vez que uma playlist toca, incrementamos um contador (`ZINCRBY` no Redis) para aquela playlist.
  - **Benefício 1 (Desempate de Fuzzy Match):** Se duas playlists tiverem nomes parecidos, o Finn prioriza a que você mais ouve.
  - **Benefício 2 (Comando Genérico):** Quando o motorista disser apenas *"Finn, coloca um som"* ou *"toca uma música"*, o Finn não pergunta qual playlist — ele já coloca a favorita daquele horário.

---

### Camada 2: Rotinas Contextuais por Horário e Dia da Semana (Médio Prazo)

80% dos trajetos de carro seguem padrões de dia da semana e faixa de horário.

#### 2.1. Matriz de Hábitos Temporais (`RoutineMatrix`)
- A cada comando executado com sucesso, um worker em background registra a tupla:
  `(driverId, diaDaSemana, janelaDeHora, acaoExecutada)`
  - *Exemplo:* `Terça-feira, 07h–08h → Waze: "trabalho" (92% das vezes) + Spotify: "Lo-Fi Beats" (80% das vezes)`.
- **Modo Predição ("Bom dia / Bora"):**
  - Quando o motorista inicia a viagem num horário com padrão forte (>70% de confiança nos últimos trajetos) ou diz *"Finn, bora"* / *"Finn, o de sempre"*, o Finn consulta o hash do Redis em ~3ms e sugere/executa:
    > *"Indo pro trabalho com a playlist Lo-Fi?"* → basta dizer *"Sim"* para disparar o comando duplo (UC7).

#### 2.2. Estilo de Personalidade do Copiloto
- Configurável no perfil (ou adaptado automaticamente):
  - **`concise` (Direto):** Respostas de 2 a 4 palavras (`"Tocando Drumz."`, `"Rota pro trabalho."`).
  - **`copilot` (Conversacional):** Respostas mais naturais e contextuais.

---

### Camada 3: Memória Episódica, Curto Prazo da Viagem & Cross-Agent Memory na Neuralake (Médio/Longo Prazo)

No código atual (`src/lib/neuralake/client.ts` e `src/lib/agent-runtime.ts`), cada chamada já prepara o campo `memoryScope: "finn-spotify"` e `"finn-waze"`. Nesta camada, estruturamos a memória por perfil de motorista (`memoryScope: "finn-user-<driverId>-<agent>"`) combinada com o Redis em **duas frentes complementares**:

#### 3.1. Memória de Curto Prazo da Viagem (Correção Natural e Conversa Contínua)
Hoje, cada comando de voz é tratado de forma isolada (exceto quando um agente pede `input-required`). Se o Finn toca a playlist errada e o motorista diz *"não, essa não, toca a outra de rock"*, ele não lembra o que acabou de tocar.
Mantendo um buffer dos **últimos 2 a 3 turnos da viagem ativa** (`ActiveTripMemory` no Redis com TTL de 2 horas e espelhado no `continuation`/contexto da janela), habilitamos três fluxos essenciais no carro:

1. **Escolha por Ordem ("A primeira" / "A segunda"):**
   - *Motorista:* "Toca rock"
   - *Finn:* "Achei Rock Nacional e Rock Clássico. Qual delas?"
   - *Motorista:* "A segunda" → O Finn sabe que `"A segunda"` refere-se a `"Rock Clássico"` sugerida no turno anterior e toca imediatamente.
2. **Correção Imediata ("Não, essa não"):**
   - *Motorista:* "Toca pagode" → Finn toca *"Pagode 90"*.
   - *Motorista:* "Não, essa não, toca a outra de pagode" → O Finn vê no histórico da viagem que *"Pagode 90"* acabou de ser escolhida, exclui ela da busca e toca a próxima candidata (*"Pagode do Fim de Semana"*).
3. **Referência Cruzada na Mesma Viagem:**
   - Lembrar o destino que acabou de ser definido ou a playlist que está tocando caso o motorista pergunte *"qual playlist está tocando mesmo?"*.

#### 3.2. Extração Assíncrona de Fatos (Background Learning & Cross-Agent Memory)
- Após cada viagem (ou ao final de cada turno via `waitUntil()` em background, sem travar a resposta de voz), o sistema consolida os fatos aprendidos no perfil do motorista (no Redis e no `memoryScope` do motorista na Neuralake):
  - Atualiza automaticamente os contadores de playlists favoritas (`topPlaylists`) e associações de apelidos (`aliases` como `"treino" -> "Drumz 🥁🗯️"`).
  - Atualiza a matriz de rotinas por dia da semana e horário (`RoutineMatrix`).
  - Persiste novos lugares aprendidos no dicionário de endereços do motorista (`savedPlaces`).

---

### Camada 4: O Harness Agêntico Proativo, Dinâmico e Auto-Otimizável (Longo Prazo)

Enquanto as Camadas 1 a 3 transformam o Finn num copiloto que conhece o motorista, a **Camada 4** transforma o próprio motor de orquestração num **Self-Improving Agentic Harness**:

#### 4.1. Descoberta Dinâmica de Skills & Roteamento Híbrido (Two-Tier Triage Router)
- **Auto-Descoberta via Agent Cards (`/.well-known/agent.json`) e MCP:** O motorista pode instalar novos agentes no seu perfil (ex.: `google-calendar-agent`, `whatsapp-agent`, `smart-home-agent`, `fuel-price-agent`).
- **Roteador de 2 Estágios:**
  - **Estágio 1 (0ms–2ms — Regex + Cache de Intenção no Redis):** Se a frase bater com uma keyword registrada ou com um comando que esse motorista já falou antes (cacheado no Redis), roteia instantaneamente sem LLM.
  - **Estágio 2 (~150ms — Triage Router Leve):** Se o motorista pedir algo inédito envolvendo múltiplos agentes instalados, o Harness inspeciona as `skills` dos Agent Cards ativos do motorista e monta um plano de execução.

#### 4.2. Execução em Grafo (DAG) — Encadeamento entre Agentes (Pipelines A2A)
- Evolui do fan-out puramente independente (`Promise.all`) para suportar dependências entre agentes quando a saída de um alimenta a entrada do outro:
  - *Exemplo real:* Motorista diz *"Finn, me leva para a minha próxima reunião"*.
  - **Passo 1:** O Harness aciona o `calendar-agent` → obtém o local do evento das 14h (*"Av. Brigadeiro Faria Lima, 3477"*).
  - **Passo 2:** Injeta esse endereço como entrada do `waze-agent` → gera o deep link de navegação para a reunião.
  - **Passo 3 (Opcional):** Se o motorista completou com *"e avisa o João que estou indo"*, aciona o `whatsapp-agent` em paralelo.

#### 4.3. Copiloto Proativo Baseado em Gatilhos de Contexto (Event-Driven Triggers)
- O Harness deixa de ser apenas reativo à voz e passa a reagir a eventos do contexto (sensores do PWA, GPS, horário e agenda):
  - **Gatilho de Proximidade (Geofence no PWA):** A 200 metros do endereço salvo como `casa`, o Harness pode oferecer/acionar um webhook ou agente de Smart Home (*"Chegando em casa. Quer abrir o portão?"*).
  - **Gatilho de Agenda:** Ao iniciar uma viagem 20 minutos antes de um compromisso presencial com endereço no calendário, sugere imediatamente a rota.

#### 4.4. Loop de Auto-Otimização de Prompts e Fast-Paths (Self-Improving Harness)
1. **Compilação Automática de Fast-Paths (Prompt-to-Rule Distillation):**
   - Quando um comando novo exige chamadas completas ao LLM, o worker em background analisa a execução.
   - Se o motorista repete a mesma intenção/comando 3 vezes, o worker destila uma **regra determinística cacheada no Redis** para aquele perfil (`intenção normalizada → tool_call + argumentos`).
   - Nas próximas vezes, um comando que levava ~2,5s no LLM passa a ser resolvido em **~5ms direto do Redis**, pulando até a 1ª chamada de LLM.
2. **Avaliação Automática por Feedback Implícito (Implicit Feedback Eval):**
   - Se o motorista faz um pedido e, em menos de 15 segundos, emite outro comando do mesmo domínio corrigindo ou trocando a ação (ex.: pediu uma playlist e logo trocou para outra), o Harness registra `implicit_negative_feedback` no turno anterior.
   - O Background Worker usa esses sinais para recalibrar os pesos de fuzzy-match e os exemplos (*few-shot*) injetados no prompt daquele motorista.

---

### Resumo Comparativo das 4 Camadas

| Camada | Foco Principal | Latência | Como o Finn age |
| :--- | :--- | :--- | :--- |
| **Camada 1** | **Memória de Entidades** (Lugares dinâmicos + Apelidos/Top Playlists) | `~0-5ms` | Entende o vocabulário próprio do motorista (*"academia"*, *"meu treino"*). |
| **Camada 2** | **Rotina Temporal** (Dia da semana + Horário) | `~3-5ms` | Antecipa trajeto e música ao entrar no carro (*"O de sempre?"*). |
| **Camada 3** | **Memória Episódica & Curto Prazo** (Últimos turnos + Neuralake Scope) | `~5-8ms` | Mantém conversa contínua (*"a segunda"*, *"não, essa não"*). |
| **Camada 4** | **Harness Autônomo** (DAGs A2A, Gatilhos Proativos & Auto-Compilação) | `~5ms` (cacheado) | Encadeia agentes (Agenda → Waze), reage ao contexto e compila hábitos em regras instantâneas no Redis. |

---

## 4. Estratégia de Evolução de Persistência (Do Zero-Infra ao Redis)

Para manter a filosofia ágil e sem gargalos de latência, a persistência evolui em dois níveis compatíveis entre si:

- **Nível 1 (Imediato — Zero Custo / Local-First):** O objeto `DriverProfile` (endereços aprendidos, apelidos de playlists, histórico de horários e últimos 2 turnos da viagem) fica salvo no `localStorage` do celular do motorista e vai junto no `driverContext` a cada requisição (0ms de latência de leitura).
- **Nível 2 (Multi-Device & Produção com Redis + Identidade Spotify):** Ao conectar o Spotify via OAuth, vinculamos o `DriverProfile` ao `spotify_user_id` do motorista e sincronizamos com o **Redis (Upstash em `gru1` São Paulo)** para leitura em ~3–8ms e escrita assíncrona em background, permitindo que o perfil acompanhe o motorista em qualquer aparelho sem depender apenas da memória local do navegador.

---

## 5. Schema Proposto para o Redis (`DriverProfile` & `ActiveTripMemory`)

Estrutura leve em JSON/Hashes no Redis (~2 KB por motorista, leitura em <5ms):

```ts
export interface DriverProfile {
  driverId: string;
  updatedAt: string;

  /** Preferências de voz e personalidade */
  preferences: {
    ttsMode: "native" | "openai";
    speechStyle: "concise" | "copilot";
  };

  /** Todos os lugares aprendidos (casa, trabalho, academia, mãe, etc.) */
  savedPlaces: Record<
    string,
    {
      label: string;
      address: string;
      useCount: number;
      lastUsedAt: string;
    }
  >;

  /** Apelidos aprendidos (ex: "treino" -> playlistId) e contagem de uso */
  musicProfile: {
    aliases: Record<string, { playlistId: string; playlistName: string }>;
    playCounts: Record<string, { name: string; count: number; lastPlayedAt: string }>;
  };

  /** Padrões por faixa de horário (ex: "mon-07", "tue-18") */
  routines: Record<
    string,
    {
      topDestination?: string;
      topPlaylist?: string;
      count: number;
    }
  >;
}

/** Estado volátil da viagem atual (TTL de 2h no Redis) */
export interface ActiveTripMemory {
  contextId: string;
  lastTurns: Array<{
    timestamp: number;
    userTranscript: string;
    assistantSpeech: string;
    agentResults: {
      spotify?: { lastPlayedPlaylist?: { id: string; name: string }; lastSuggestions?: string[] };
      waze?: { lastDestination?: string };
    };
  }>;
}
```

---

## 6. Ordem Recomendada de Implementação

1. **Etapa 1 — Memória de Curto Prazo da Viagem (`ActiveTripMemory`):**
   - Permitir responder *"a primeira"*, *"a segunda"* quando houver sugestões de playlist, e *"não, essa não"* para trocar a playlist recém-colocada.
2. **Etapa 2 — Lugares Dinâmicos no Waze + Aliases de Playlist:**
   - Expandir o `AddressBook` de `casa | trabalho` para qualquer lugar falado pelo motorista e salvar a frequência das playlists.
3. **Etapa 3 — Integração Upstash Redis (`@upstash/redis` via HTTP/Edge em São Paulo `gru1`):**
   - Persistir o `DriverProfile` na nuvem com leitura de ~5ms e gravação assíncrona em background (`waitUntil`), sincronizado com o `localStorage` do PWA.
4. **Etapa 4 — Predição de Rotina por Horário ("Modo Rotina"):**
   - Sugerir ou ativar automaticamente a combinação de Waze + Spotify baseada no dia da semana e horário em que o motorista entra no carro.
