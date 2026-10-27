# Procedimento: rotação e revogação do segredo A2A

Contrato: [`isolamento-por-motorista.md`](../contratos/isolamento-por-motorista.md), passo 3, ponto 4. Quem executa é o dono (Vercel é do dono); o agente só mantém este roteiro. Nunca cole valores em chat, commit, ticket ou log.

## O que é o segredo

`FINN_A2A_TOKEN` é a credencial do **dono** no endpoint `/api/agents/[agent]`: quem a tem age como o dono (Spotify do servidor, endereços do dono). Formato: 64 caracteres hexadecimais (`openssl rand -hex 32`), pelo menos 8 caracteres distintos. Tem de ser diferente de `FINN_API_TOKEN` e de `FINN_A2A_TOKEN_NEXT`. Qualquer valor ausente, inválido ou repetido desliga o endpoint (503, falha fechada).

## Criar (primeira vez)

Só depois do security-review do passo 3 aprovado. Criar `FINN_A2A_TOKEN` no ambiente certo, fazer redeploy, entregar o valor ao cliente por canal seguro.

## Rotacionar sem derrubar o cliente

1. Gerar um segredo novo e criar `FINN_A2A_TOKEN_NEXT` com ele (mesmo ambiente). Não mexer em `FINN_A2A_TOKEN`.
2. Redeploy. Nesta janela o endpoint aceita os dois segredos.
3. Trocar o segredo no cliente A2A para o novo. Conferir que as chamadas passam.
4. Promover: colocar o valor novo em `FINN_A2A_TOKEN` e apagar `FINN_A2A_TOKEN_NEXT`. Redeploy.
5. O segredo antigo deixa de funcionar nesse redeploy (401). Se alguma chamada ainda falhar, o cliente não foi trocado no passo 3.

Se o redeploy do passo 2 ou 4 deixar o endpoint em 503, algum valor está inválido ou igual a outro: conferir formato e unicidade (sem imprimir os valores).

## Revogar (suspeita de vazamento)

Remover `FINN_A2A_TOKEN` e `FINN_A2A_TOKEN_NEXT` e fazer redeploy: o endpoint passa a responder 503. Para reabrir, siga "Criar" com um valor novo. Um segredo vazado não se "desfaz": troque-o sempre.

## Limite de tentativas

Falhas de autenticação são contadas no Redis por IP (`ratelimit:a2a:<ip>`): 10 falhas por 600 s; IP ausente ou inválido usa o balde `noip`, de 3. Passou do limite: 429 com `Retry-After`, mesmo para o segredo certo, até a janela expirar. Acertos não contam. Redis fora do ar: 503. A trava vale por IP, então atrás de NAT compartilhado um cliente errado pode bloquear os outros daquele IP durante 10 minutos.
