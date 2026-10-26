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
