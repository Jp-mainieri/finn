# Entrega 1: núcleo de identidade (driver-store-core), 2026-10-26

Arquivos: `src/lib/driver/{store,invite,memory-store,upstash-store,session-token,index}.ts`, `driver.test.ts` (24 testes), `@upstash/redis@1.40.0`.

## Escolhas de implementação
- Resgate atômico no Upstash: um único `EVAL` Lua (`REDEEM_SCRIPT`) que confere revogado/usos/expiração, faz `HINCRBY uses` e cria o motorista (`HSET`) no mesmo passo. Motivo: INCR-com-checagem em dois passos deixa janela de corrida entre a checagem e a criação do driver; o script é indivisível no Redis, e se o driver falhar nada foi consumido. O rótulo do convite (imutável) é lido antes, fora do script.
- Convite e motorista são hashes Redis (não JSON): `HSET`/`HINCRBY` atômicos sem ler-e-reescrever. Cliente criado com `automaticDeserialization: false` para rótulos como "1e3" não virarem número.
- Revogação (`REVOKE_SCRIPT`) só escreve se a chave existe (evita hash fantasma). Rate limit (`RATELIMIT_SCRIPT`): INCR + EXPIRE atômicos, repara contador sem TTL.
- Timestamps de Driver/Invite em ms; `iat`/`exp` do token em segundos.
- `getDriverStore()`: só `development`/`test` (VERCEL_ENV ausente = development) caem no fake; preview, production, valor desconhecido, ou NODE_ENV=production sem VERCEL_ENV exigem KV_* e lançam sem eles. `FINN_SESSION_SECRET` é exigido em qualquer ambiente, mínimo 32 caracteres.
- Rate limit de resgate: padrão 10 por 600 s por IP (`REDEEM_RATE_LIMIT`), valor provisório, parâmetro.
- Código de convite inválido na forma retorna null sem tocar o store; entrada é normalizada (trim, maiúsculas).

## Limitações
- Scripts Lua NÃO foram executados contra Redis (proibido rede). O mock emula a semântica em TS; a sintaxe Lua e o comportamento real do Upstash (`unpack(ARGV, 2)`, `eval` do SDK) são hipótese até um teste manual do dono em preview.
- Se `createDriver` do resgate falha por erro de rede após o script, o resultado é indeterminado para o cliente (mas a operação é única, sem estado parcial).

## Rodada de correções (qa + security-review)
Testes: `npm test` 431 passaram, 4 ignorados, 0 falharam (antes 403); `src/lib/driver` 52 (28 novos); typecheck e lint limpos.

| Achado | Estado | Como |
|---|---|---|
| B1/F1 hgetall array | corrigido | `hashToRecord` aceita array plano e objeto; Number+isSafeInteger; `as never` removido. Teste com o `Redis` REAL do SDK e `fetch` falso no formato REST (HGETALL plano, EVAL numérico/array), ponta a ponta |
| A1 vazamento em erro | corrigido | todo acesso passa por `call()`; relança `DriverStoreUnavailableError` sem message/cause do SDK; teste de que nada (comando, chave, hash, token, driverId, IP) aparece |
| N1/M5/M6 timeout/retry/null | corrigido | `createRedisClient`: `signal` como FUNÇÃO (`AbortSignal.timeout`, 2000 ms, parâmetro), `retries: 0` (no SDK `retry:false` ainda faz 2 tentativas, nodejs.js:154), auto-pipeline off. Resposta não numérica/ausente lança. Testes: Redis pendurado falha no teto; 1 única chamada em falha; sem retry no resgate |
| N3 windowSeconds | corrigido | inteiro 1..86400, memory e upstash |
| N4 chave de rate limit | corrigido | só `ratelimit:` + charset restrito, ambos os stores |
| N5 NODE_ENV=production | corrigido | nunca relaxa; teste de `getDriverStore()` e singleton (falha não é cacheada) |
| N6 base64url canônico | corrigido | regex + reencode igual, em assinatura e corpo |
| N7 token | corrigido | tv 0..MAX_SAFE, exp <= iat+90d, iat <= agora+60s, sign valida tokenVersion/relógio. Segredo: exatamente 64 hex com >= 8 caracteres distintos (mais estrito que 32 chars; segue o formato do contrato) |
| N8 / B5 driverId | corrigido | `toDriver` confere a chave pedida; `authenticateSession` confere `sub` |
| N10 entradas | corrigido | label trim 1..64 sem controle/ANSI; maxUses 1..1000; expiresAt em ms, futuro, <= 1 ano (JSDoc) |
| N9/M4/B1 | corrigido (parcial por escopo) | resgate é sempre 1 EVAL (label lido dentro do Lua); IPv6 /64, IPv4-mapped, IP ausente/inválido em balde próprio (3/600 s). Sem limite global (fora de escopo) |
| Dependência | corrigido | `@upstash/redis` exato 1.40.0, `enableTelemetry:false` (teste confere ausência dos headers) |
| Por ordem, não feito | pepper/HMAC do convite (M3), rotateSessions (M1), vínculo de ambiente no token (B3), credencial do Redis (M2) | aguardam o dono |

Não verificado: Lua segue sem rodar em Redis real (hipótese); o formato REST do fake foi derivado do código do SDK 1.40.0, não de resposta real do Upstash (hipótese). `redeemInvite` e demais métodos agora lançam `DriverStoreUnavailableError` em falha de Redis; a entrega 2 deve tratar como negação/erro falável.
