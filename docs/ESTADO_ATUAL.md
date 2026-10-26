# Finn — estado atual

Atualizado em 2026-10-26. Processo: [`ORQUESTRACAO.md`](./ORQUESTRACAO.md). Arquitetura: [`ARCHITECTURE.md`](./ARCHITECTURE.md). Plano: [`PERSONALIZATION_AND_LEARNING.md`](./PERSONALIZATION_AND_LEARNING.md).

## Estado

- MVP funcionando no carro (iPhone PWA, v0.5.8). Wake word Porcupine, STT Groq Whisper, Neuralake + fallback Groq, agentes Spotify e Waze.
- `main` limpo e sincronizado. 379 testes passam (4 pulados live), typecheck e lint limpos (2026-10-26).
- Sem CI. Lote completo roda localmente, uma vez por branch.
- Persistência: nenhuma durável. Endereços ditados vivem na memória da função (somem no cold start).

## Decisões fechadas

- 2026-10-22: voz STT+TTS padrão; GPT-Live-1 bloqueado por custo (`ENABLE_GPT_LIVE=1`).
- 2026-10-22: fast-path de 1 round-trip (`FINN_FAST_SPEECH=1`).
- 2026-10-22: multi-user stateless via `driverContext` (a ser substituído pela etapa 1).
- 2026-10-26: ordem de evolução: (1) Redis + `DriverProfile` + identidade, (2) memória curta da viagem, (3) lugares dinâmicos e aliases, depois rate limit e observabilidade antes de abrir o beta, (4) Modo Rotina. Camada 4 do plano espera.
- 2026-10-26: o beta será aberto a outras pessoas, mas só com acesso controlado pelo dono.

## Decisões provisórias

- **Identidade (opção B, 2026-10-26):** `driverId` opaco gerado pelo servidor; token de sessão assinado, emitido em troca de código de convite criado e revogável pelo dono. O Spotify ID é só atributo ligado ao perfil (índice `spotify:<id> → driverId`). Substitui o `FINN_API_TOKEN` compartilhado.
  - Convites criados e revogados por script local rodado pelo dono (sem rota de admin). Contrato aprovado em 2026-10-26: [`contratos/identidade-e-perfil.md`](./contratos/identidade-e-perfil.md).
  - Reabre se: for preciso convidar pelo celular com frequência (rota de admin), for preciso login sem convite (migrar para OAuth Spotify, opção C, só troca a forma de emitir o token), ou o OAuth quebrar no iOS standalone PWA.

## Casos cinzentos aceitos

- OAuth do Spotify dentro de PWA standalone no iOS: comportamento do redirect não verificado. Desenho esperado: abrir fora do PWA e voltar com o token já emitido pelo servidor.
- Modo desenvolvimento do Spotify limita a 25 usuários cadastrados à mão; acima disso exige extensão de cota.

## Débitos

1. Perfis misturados: `LayeredAddressBook` grava também no `baseBook` global (vazamento entre motoristas). Etapa 1, entrega 2.
2. Refresh token do Spotify trafega do aparelho no `driverContext`. Etapa 1, entrega 3.
3. Token único compartilhado `FINN_API_TOKEN`. Etapa 1 (identidade).
4. Sem rate limit por motorista nem métricas de latência/fallback. Antes do beta.
5. Dependência da Neuralake (429 frequente, mascarada pelo fallback Groq). Acompanhar taxa de fallback.
6. `README.md` é o template do Create Next App. Branches `feat/*` já mergeadas podem ser apagadas.
7. TODO `neuralake-memory`: a Neuralake não documenta memória por agente.

## Pré-lançamento (antes de abrir a usuários reais)

- [ ] Etapa 1 concluída e revisada (qa + security-review).
- [ ] Rate limit por motorista.
- [ ] Métricas de latência e de fallback.
- [ ] Restringir `NEXT_PUBLIC_PICOVOICE_ACCESS_KEY` no painel da Picovoice.
- [ ] Checklist `tests/MANUAL.md` rodada na build de produção.
- [ ] Spotify: avaliar extensão de cota se passar de 25 usuários.

## Pendências do dono

- [ ] Provisionar Upstash Redis (Marketplace da Vercel, região `gru1`) e avisar quando as variáveis estiverem no projeto. O agente só precisa dos nomes.
- [ ] Definir variáveis novas quando listadas (ex.: chave de assinatura de sessão, chave de criptografia do refresh token, convites iniciais). Valores são do dono.
- [ ] OK de merge de cada PR.

## Em aberto (do dono)

Nenhuma decisão aberta no momento.
