# iGaming Backend — Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) recebidas de vários provedores por HTTP e por fila SQS. Várias instâncias podem tocar a mesma wallet ao mesmo tempo sem duplicar débitos ou créditos, sem saldo negativo e sem perder eventos confirmados.

**Stack:** Bun · TypeScript estrito · NestJS (Fastify) · PostgreSQL 16 · MikroORM · AWS SQS via LocalStack · Docker Compose.

As decisões técnicas (ORM, dinheiro, transações, concorrência, inbox/outbox, hash de idempotência, códigos de falha, PENDING_REFERENCE, autenticação, limitações) estão em [ARCHITECTURE.md](ARCHITECTURE.md).

## Pré-requisitos

| Ferramenta | Para quê |
|------------|----------|
| Docker com Compose v2 | PostgreSQL, LocalStack e as duas instâncias da aplicação |
| Bun 1.4+ | Testes, migrations e execução local |
| Node.js 22.9+ | `bun run start` (o Nest CLI executa a aplicação com `node --env-file-if-exists`) |

## Subir o ambiente

```bash
cp .env.example .env
docker compose up -d --build
```

Isso sobe quatro containers:

| Container | Porta no host | Papel |
|-----------|---------------|-------|
| `igaming_postgres` | 5433 | PostgreSQL 16 |
| `igaming_localstack` | 4566 | SQS. As filas são criadas na subida |
| `igaming_app` | 3000 | Aplicação: API, consumidor SQS e workers |
| `igaming_app2` | 3001 | Segunda instância da mesma aplicação, para concorrência real |

Em seguida aplique as migrations (próxima seção) e confira:

```bash
curl -s localhost:3000/health/ready
curl -s localhost:3001/health/ready
```

As migrations não rodam sozinhas no boot. Até serem aplicadas, os workers registram erro no log a cada ciclo e se recuperam sozinhos depois.

## Migrations

Pelo container (não precisa de nada instalado no host):

```bash
docker compose exec app node node_modules/.bin/mikro-orm migration:up
docker compose exec app node node_modules/.bin/mikro-orm migration:list
```

Ou pelo host, com Bun (usa o `.env`, que aponta para `localhost:5433`):

```bash
bun install
bun run migration:up        # aplica as pendentes
bun run migration:list      # aplicadas
bun run migration:down      # desfaz a última (todas têm down)
bun run migration:create    # nova migration em src/infrastructure/persistence/migrations
```

| Migration | Conteúdo |
|-----------|----------|
| `InitialSchema` | Tabelas, ENUMs, `CHECK` de saldo não negativo, `UNIQUE` de idempotência e índices |
| `LedgerImmutability` | Triggers que bloqueiam `UPDATE`, `DELETE` e `TRUNCATE` no ledger |
| `OutboxAggregateIndex` | Índice do publisher do outbox |
| `PendingReferenceScheduling` | Agendamento do reprocessamento de PENDING_REFERENCE |

## Filas no LocalStack

O script `scripts/localstack-init.sh` roda automaticamente quando o LocalStack fica pronto e cria as filas:

| Fila | Uso |
|------|-----|
| `wager-transactions.fifo` | Entrada de transações. `RedrivePolicy` para a DLQ com `maxReceiveCount` 5 |
| `wager-transactions-dlq.fifo` | Dead-letter queue |
| `wager-events.fifo` | Eventos publicados pelo outbox |

Para conferir ou recriar manualmente (por exemplo, depois de reiniciar o LocalStack, que não persiste mensagens):

```bash
docker exec igaming_localstack awslocal sqs list-queues
docker exec igaming_localstack sh /etc/localstack/init/ready.d/init.sh
```

## Comandos

| Comando | O que faz | Precisa do compose? |
|---------|-----------|---------------------|
| `bun install` | Instala as dependências | não |
| `bun run start` | Compila e roda a aplicação no host usando o `.env` | PostgreSQL e LocalStack |
| `bun run start:dev` | Mesmo, com watch | PostgreSQL e LocalStack |
| `bun run test` | Suíte completa: unitários, integração e concorrência com 3 processos reais | PostgreSQL e LocalStack |
| `bun run test:unit` | Só os unitários (`src/`) | não |
| `bun run test:integration` | Só integração e concorrência (`test/integration`) | PostgreSQL e LocalStack |
| `bun run test:load` | Teste de carga contra as duas instâncias | tudo, com migrations aplicadas |

**Rodar no host junto com o compose.** A porta 3000 já está com `igaming_app`, então use outra porta. Esta instância também consome a mesma fila que as do compose:

```bash
APP_PORT=3005 bun run start
```

**Testes.** Cada arquivo de teste cria o próprio banco (`igaming_test_*`) e as próprias filas (`test-*`) e apaga tudo no fim, então o banco e as filas do compose não são tocados. A suíte leva cerca de 1 minuto.

## Exemplos de chamadas

Os exemplos usam shell e `curl`. Troque `3000` por `3001` para falar com a outra instância: o resultado é o mesmo.

```bash
API=http://localhost:3000
PLAYER=$(cat /proc/sys/kernel/random/uuid)
RUN=$(date +%s)   # sufixo para os ids externos: o bloco pode ser executado mais de uma vez

# Criar wallet com saldo inicial (gera OPENING + CREDIT no ledger)
WALLET=$(curl -s -X POST $API/wallets -H 'content-type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}" \
  | sed -E 's/.*"id":"([^"]+)".*/\1/')

# BET: 201 na primeira vez
curl -s -X POST $API/wagering/transactions -H 'content-type: application/json' \
  -H "Idempotency-Key: provider-a:bet-$RUN" \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"bet-$RUN\",\"walletId\":\"$WALLET\",\"playerId\":\"$PLAYER\",\"roundId\":\"round-1\",\"gameId\":\"game-1\",\"kind\":\"BET\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"

# Mesma requisição de novo: 200 com "idempotentReplay": true, sem novo débito
# (mesma chave com payload diferente responde 409 PAYLOAD_CONFLICT)

# WIN referenciando o BET
curl -s -X POST $API/wagering/transactions -H 'content-type: application/json' \
  -H "Idempotency-Key: provider-a:win-$RUN" \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"win-$RUN\",\"walletId\":\"$WALLET\",\"playerId\":\"$PLAYER\",\"roundId\":\"round-1\",\"gameId\":\"game-1\",\"kind\":\"WIN\",\"money\":{\"amount\":\"60.00\",\"currency\":\"BRL\"},\"referenceExternalTransactionId\":\"bet-$RUN\"}"

# REFUND de um BET que ainda não chegou: 202 PENDING_REFERENCE.
# Quando o late-bet-$RUN chegar, o worker aplica a REFUND sozinho.
curl -s -X POST $API/wagering/transactions -H 'content-type: application/json' \
  -H "Idempotency-Key: provider-a:refund-$RUN" \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"refund-$RUN\",\"walletId\":\"$WALLET\",\"playerId\":\"$PLAYER\",\"roundId\":\"round-1\",\"gameId\":\"game-1\",\"kind\":\"REFUND\",\"money\":{\"amount\":\"10.00\",\"currency\":\"BRL\"},\"referenceExternalTransactionId\":\"late-bet-$RUN\"}"

# Consultas
curl -s $API/wallets/$WALLET
curl -s "$API/wallets/$WALLET/ledger?limit=2"            # use "nextCursor" em ?cursor=... para a próxima página
curl -s $API/providers/provider-a/wagering/transactions/bet-$RUN
curl -s $API/wagering/transactions/<transactionId>

# Reconciliação: saldo armazenado × soma do ledger (divergência é sinalizada, nunca corrigida)
curl -s -X POST $API/wallets/$WALLET/reconciliation

# Operação
curl -s $API/health/live
curl -s $API/health/ready
curl -s $API/metrics | grep -E '^(wagering_transactions_total|wagering_duplicates_total|wallet_lock_conflicts_total|outbox_lag_seconds|sqs_dlq_depth|pending_reference_transactions)'
```

Enviando a mesma transação pela fila (corpo igual ao da API, com `idempotencyKey` dentro do corpo e `MessageGroupId` igual à wallet):

```bash
docker exec igaming_localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id "$WALLET" --message-deduplication-id sqs-bet-$RUN \
  --message-attributes '{"correlationId":{"DataType":"String","StringValue":"minha-req-1"}}' \
  --message-body "{\"idempotencyKey\":\"provider-a:sqs-bet-$RUN\",\"providerId\":\"provider-a\",\"externalTransactionId\":\"sqs-bet-$RUN\",\"walletId\":\"$WALLET\",\"playerId\":\"$PLAYER\",\"roundId\":\"round-1\",\"gameId\":\"game-1\",\"kind\":\"BET\",\"money\":{\"amount\":\"5.00\",\"currency\":\"BRL\"}}"

docker compose logs app app2 | grep minha-req-1      # qualquer instância pode consumir; mesmo correlationId em todas as linhas
```

### Status HTTP

| Situação | Status |
|----------|--------|
| Transação nova processada, wallet criada | 201 |
| Replay de transação processada, consultas, reconciliação | 200 |
| Aguardando referência (PENDING_REFERENCE) | 202 |
| Rejeitada por regra de negócio (`failureCode` na resposta) | 422 |
| Payload, header ou parâmetro inválido. Valor monetário como número JSON também | 400 |
| Wallet ou transação inexistente | 404 |
| Mesma `Idempotency-Key` com payload diferente, ou wallet duplicada | 409 |
| Falha transitória de infraestrutura (com `Retry-After`) | 503 |

## Teste de carga

```bash
bun run test:load
LOAD_OPERATIONS=10000 LOAD_CONCURRENCY=128 bun run test:load   # parâmetros opcionais
```

**Metodologia.** O teste usa as duas instâncias do compose e:

1. Cria 40 wallets com 10000.00.
2. Dispara 4000 transações HTTP com 64 clientes concorrentes, alternando entre as instâncias.
3. Concentra 30% das operações em 4 wallets "quentes", para gerar disputa real pelo lock.
4. Mistura BET, WIN referenciando BET, LOSS, REFUND, BET acima do saldo (rejeitada) e 10% de reenvios idênticos (replay).
5. Depois da carga, espera o outbox e as pendências de referência drenarem e reconcilia todas as wallets.
6. Falha com código 1 se houver erro 5xx, erro de rede ou divergência.

**Resultado registrado** (2 instâncias no compose, mesma máquina para PostgreSQL, LocalStack, aplicação e gerador de carga):

| Ambiente | |
|---|---|
| CPU | AMD Ryzen 5 7520U × 8 |
| Memória | 14.9 GiB |
| SO | Linux 6.7 |

| Métrica | Valor |
|---|---|
| Operações | 4000 (BET 2326, WIN 598, LOSS 424, REFUND 179, BET rejeitada 81, replay 392) |
| Throughput | 179 req/s |
| Latência p50 / p95 / p99 | 388 ms / 650 ms / 836 ms |
| Status HTTP | 201: 3519 · 200: 387 · 422: 84 · 202: 10 |
| Taxa de erro (5xx + rede) | 0% |
| Conflitos de lock nas wallets | 1392 |
| Duplicatas detectadas | 392 (todos os replays) |
| Outbox lag máx. durante a carga | 5.1 s (1656 eventos pendentes no pico) |
| Drenagem após a carga | 3.5 s |
| Wallets divergentes na reconciliação | 0 de 40 |

A latência é dominada pela fila de 64 clientes sobre o pool padrão de 10 conexões por instância e pela serialização proposital das wallets quentes. Os números valem só para esta máquina. A análise do lag do outbox está em [ARCHITECTURE.md](ARCHITECTURE.md#trade-offs-e-limitações-conhecidas).

## Estrutura

```
src/
├── domain/          Money, Wallet, WagerTransaction, ledger, eventos, inbox/outbox, política de PENDING_REFERENCE
├── application/     casos de uso, portas, validação, hash de idempotência
├── infrastructure/
│   ├── persistence/ MikroORM: entidades, migrations, unit of work, read model, outbox store
│   ├── http/        controllers, filtro de erros, autenticação (ponto de extensão)
│   ├── messaging/   consumidor SQS, publisher do outbox, injeção de falhas para teste
│   ├── workers/     worker de PENDING_REFERENCE
│   ├── observability/ logs JSON, correlação, métricas
│   └── health/      /health/live, /health/ready
└── shared/
test/
├── integration/     PostgreSQL e LocalStack reais, inclusive 3 processos da aplicação
└── load/            teste de carga
```
