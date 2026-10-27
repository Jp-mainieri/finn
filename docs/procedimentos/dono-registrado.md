# Procedimento: dono registrado (FINN_OWNER_DRIVER_ID)

Contrato: [`pwa-convite-e-dono.md`](../contratos/pwa-convite-e-dono.md). Quem executa é o dono (Vercel e Upstash são do dono). Nunca cole valores secretos em chat, commit ou log. O `driverId` não é segredo, mas não o publique.

## O que é o dono

O dono é o único que usa `SPOTIFY_REFRESH_TOKEN` e `WAZE_SAVED_ADDRESSES` do servidor, e o A2A roda como ele. É o motorista cujo `driverId` está em `FINN_OWNER_DRIVER_ID`. Enquanto `FINN_LEGACY_TOKEN_ENABLED=1` e a variável não existir, o id fixo legado (`drv_legacy_owner_000000000`) faz o papel de dono, só para não cortar o carro antes da virada. Sem variável válida e sem a flag, ninguém é dono: o Spotify do servidor e a semente de endereços ficam inalcançáveis e o A2A responde 503 "A2A endpoint disabled".

## Definir FINN_OWNER_DRIVER_ID

1. O dono resgata um convite no PWA novo e roda `npm run driver:list -- --env <ambiente> ...` para ver o próprio `driverId` (formato `drv_` + 22 caracteres base64url).
2. Criar a variável na Vercel sem quebra de linha no fim, por exemplo `printf %s '<driverId>' | vercel env add FINN_OWNER_DRIVER_ID production`, e reimplantar. O servidor ignora espaços e quebras de linha nas pontas, mas aspas ou espaço no meio tornam o valor inválido.
3. Inválida (formato errado, aspas, o próprio id legado) conta como ausente: com a flag ligada o id legado continua dono; sem a flag, ninguém. O servidor registra uma linha fixa por processo: `[auth] FINN_OWNER_DRIVER_ID is invalid; ignored` (sem o valor). Procure essa linha nos logs depois do deploy; ela não pode aparecer.
4. Conferir **com a sessão nova (`v1.`), nunca com o token legado**, antes de remover `FINN_LEGACY_TOKEN_ENABLED`: `GET /api/spotify/connection` dá `connected: true`, `POST /api/spotify/connect` dá 403 e a fala de endereço do carro funciona. Em `npm run driver:list` a linha do dono aparece com "(dono)" (o script lê `FINN_OWNER_DRIVER_ID` do ambiente em que roda, por exemplo via `--env-file`; sem a variável ele avisa e não marca ninguém).
5. Só então remover a flag legada e reimplantar.

## O dono precisa estar ativo

Com a variável apontando para um id real, o token legado (`FINN_API_TOKEN`) e o A2A só valem enquanto esse motorista existe e está `active`. Efeitos:
- `driver:revoke` do dono: derruba as sessões do carro, e o token legado passa a dar 401 e o A2A 503. O Spotify e os endereços do servidor deixam de funcionar para o carro.
- `driver:rotate` do dono: invalida as sessões atuais dele (o app pede novo convite). **Não** corta o token legado nem o A2A (rotação é de sessões).
- `driver:purge` do dono: apaga os endereços ditados e qualquer blob de Spotify residual. O Spotify do carro continua (vem de `SPOTIFY_REFRESH_TOKEN`).
- Se o Redis estiver fora, o token legado dá 503 de indisponibilidade e o A2A fica desligado (falha fechada).
Os três comandos avisam "ATENÇÃO: este motorista é o DONO" quando o alvo é o dono (precisa de `FINN_OWNER_DRIVER_ID` no ambiente do script) e pedem a confirmação de sempre.

## Endereços ditados antes da virada

Os endereços que o dono ditou enquanto o id legado era dono ficam em `finn:<env>:driver-addr:drv_legacy_owner_000000000`. O dono real lê a chave do próprio `driverId`: `casa` volta à semente de `WAZE_SAVED_ADDRESSES` e `trabalho` some até ser ditado de novo. O dono dita de novo uma vez. O hash antigo não é apagado por nenhum comando (o id legado não tem registro, então `driver:purge` não o alcança): se quiser limpar, apague à mão essa chave no painel do Upstash do ambiente. Nada o lê depois da virada.
