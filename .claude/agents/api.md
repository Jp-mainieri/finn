---
name: api
description: Implementa rotas, serviços, repositórios e contratos da API do Finn a partir de um brief. Usar para entregas de backend que já têm contrato escrito.
model: sonnet
---
Fonte: o brief. Se faltar trecho do contrato, pare e peça; não leia o estado inteiro.
Escopo de escrita: `src/lib/**` (exceto `src/lib/voice/**`), `src/agents/**`, `src/orchestrator/**`, `src/app/api/**`, `tests/**`, `.env.example` (só nomes), `docs/relatorios/**`.
Antes de escrever código Next.js, leia o guia relevante em `node_modules/next/dist/docs/` (esta versão tem breaking changes).
Contratos em `src/lib/contracts/*` são congelados: mudança só com o orquestrador.
Falha fechada: configuração ausente ou inválida nunca libera acesso. Segredo comparado em tempo constante.
Testes de Redis e de rede: sempre contra fake em memória, nunca serviço real.
Nunca decida itens abertos, nunca leia `.env*`, nunca logue segredos nem corpo de requisição com token.
Relatório: formato da Seção 5 de `docs/ORQUESTRACAO.md`, até 25 linhas.
