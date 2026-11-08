# Arquitetura — Jungle Gaming Wagering Processor

Serviço que processa transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) de vários provedores, recebidas por HTTP e por SQS, com várias instâncias tocando as mesmas wallets ao mesmo tempo. Este documento registra as decisões técnicas, o porquê de cada uma e o que fica de fora.

## Visão geral

```
            HTTP (Fastify)                       SQS wager-transactions.fifo
                 │                                          │
                 ▼                                          ▼
        WageringController                         SqsWagerConsumer
                 │                                          │
                 └──────────────┐            ┌──────────────┘
                                ▼            ▼
                     ProcessWagerTransactionUseCase      ← mesmo caso de uso nas duas entradas
                                │
             uma transação SQL: lock da wallet → idempotência → regras
             → transação + ledger + saldo + outbox (+ inbox se veio da fila) → COMMIT
                                │
                                ▼
                        outbox_messages ──► OutboxRelay ──► SQS wager-events.fifo
                                ▲
       PendingReferenceWorker ──┘  (resolve PENDING_REFERENCE com backoff, mesma transação SQL)
```

Camadas (DDD/hexagonal):

| Camada | Pasta | Conteúdo |
|--------|-------|----------|
| Domínio | `src/domain`, `src/shared` | `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, eventos, `InboxMessage`, `OutboxMessage`, `PendingReferencePolicy`. Sem framework nem banco |
| Aplicação | `src/application` | Casos de uso, portas (`UnitOfWork`, `WageringReadModel`, `OutboxStore`, `EventPublisher`), validação, hash de idempotência |
| Infraestrutura | `src/infrastructure` | MikroORM, HTTP (Nest + Fastify), SQS, workers, observabilidade, health, autenticação |

## Decisão de ORM: MikroORM

**Escolha:** MikroORM 6 com o driver PostgreSQL.

- **Unit of Work nativa.** `em.fork().transactional()` dá uma transação SQL por operação, com identity map isolado por transação. Nada vaza entre requisições.
- **Lock pessimista de primeira classe.** `LockMode`, `FOR UPDATE` e a saída para SQL cru (`em.execute`) na mesma conexão da transação. O `SKIP LOCKED` do outbox, o `NOWAIT` com savepoint do lock da wallet e a paginação por keyset do ledger precisam disso.
- **Migrations em TypeScript, versionadas e reversíveis.** Cada migration tem `down()`, e triggers e ENUMs nativos do PostgreSQL ficam no mesmo fluxo.
- **Integração com Nest.** `@mikro-orm/nestjs` gerencia o ciclo de vida e fecha o pool depois dos workers no shutdown.

**Escritas explícitas.** O domínio não é anotado com decorators: as entidades ficam em `infrastructure/persistence/entities` e os mappers convertem. As escritas usam `em.insert` e `em.nativeUpdate` em vez do flush implícito do identity map. Cada comando SQL é emitido no ponto em que aparece no caso de uso, o que deixa a ordem (lock → leituras → escritas) explícita e revisável.

Alternativas descartadas:
- **Prisma.** Não expõe `SELECT ... FOR UPDATE` nem `SKIP LOCKED` sem SQL cru, e o modelo de transação interativa é menos direto.
- **TypeORM.** Viável, mas o controle de transação e de lock é menos explícito, e o enunciado indica o MikroORM como preferencial.

## Mapeamento do `Money` no banco

| Onde | Como |
|------|------|
| Colunas | Valor e moeda separados: `*_amount DECIMAL(19,4)` e `*_currency CHAR(3)` (`balance_*`, `money_*`, `balance_before_amount`, `balance_after_amount`) |
| Tipo no TypeScript | `string` em todas as entidades. **Nunca `number`**: o driver devolve `DECIMAL` como texto e assim fica até o `Money` |
| Value object | `Money` usa `decimal.js`. Aceita no máximo 2 casas, rejeita negativos, `NaN`, infinito e notação científica, normaliza para 2 casas (`"10.0"` → `"10.00"`) e só soma ou subtrai na mesma moeda |
| API | Valor sempre string (`"25.00"`). Um número JSON é rejeitado com 400, para não haver arredondamento binário em nenhum ponto da entrada |
| Banco como última barreira | `CHECK (balance_amount >= 0)` na wallet e `UNIQUE (player_id, currency)` |

`DECIMAL(19,4)` deixa folga de escala acima das 2 casas de negócio. A reconciliação lê os valores exatos do banco (sem passar pelo `Money`) justamente para mostrar um valor corrompido como ele está.

## Estratégia transacional

Porta `UnitOfWork` (`src/application/ports/unit-of-work.port.ts`), implementada por `MikroOrmUnitOfWork` sobre `em.fork().transactional()`. Os casos de uso recebem repositórios transacionais e nunca veem o ORM.

Uma transação processada é **um único commit** contendo:

1. a linha em `wager_transactions` (inclusive REJECTED e PENDING_REFERENCE, que também são resultados);
2. o lançamento em `wallet_ledger_entries`, quando há movimento;
3. o novo saldo e a nova versão em `wallets`;
4. os eventos em `outbox_messages`;
5. o registro em `inbox_messages`, quando a entrada veio da fila.

Ou tudo é gravado, ou nada é. Erros do driver são traduzidos na borda do repositório (`driver-errors.ts`):
- **`UNIQUE` violada** vira `UniqueViolationError`: outra instância gravou a mesma chave primeiro, e o caso de uso tenta de novo até 3 vezes. A nova tentativa encontra a linha vencedora e responde como replay.
- **Falha de conexão** vira `TransientInfrastructureError`. Isso cobre SQLSTATE `08xxx`, `57P01/02/03`, `53300`, `40001`, deadlock, lock indisponível, FATAL na abertura e conexão morta durante a transação. O resultado é HTTP 503 com `Retry-After`, ou retry com backoff na fila.

### Imutabilidade do ledger

`wallet_ledger_entries` é append-only **no schema**: triggers rejeitam `UPDATE`, `DELETE` e `TRUNCATE` (`Migration20261107_LedgerImmutability`). `UNIQUE (transaction_id)` garante no máximo um lançamento por transação. Correção de erro se faz com uma nova transação (REFUND ou ROLLBACK), nunca editando o passado.

## Estratégia de concorrência

**Escolha: lock pessimista na wallet** (`SELECT ... FOR UPDATE`). A unidade de concorrência é a `walletId`.

Dentro da transação SQL, em ordem:

1. trava a linha da wallet;
2. verifica idempotência (chave e `(providerId, externalTransactionId)`), **sob o lock**;
3. aplica as regras com o saldo travado;
4. grava tudo e faz commit, liberando o lock.

**Por que pessimista e não otimista:**
- **Wallets quentes.** O cenário obrigatório (duas BETs de 80.00 sobre 100.00) e a mesma aposta enviada 50 vezes são exatamente o caso de alta contenção numa wallet. Com locking otimista, cada colisão vira rollback e nova tentativa. Sob contenção real isso gera tempestade de retries e latência imprevisível, e um limite de tentativas pode virar erro para o cliente. Com o lock, as operações da wallet simplesmente se enfileiram, cada uma vê o saldo confirmado da anterior e nenhuma é refeita.
- **Idempotência simples.** Sob lock, "já existe?" e "insere" não têm janela entre si. A `UNIQUE` continua como rede de segurança.
- **Custo.** Wallets diferentes não disputam nada. O teste de carga mede o efeito: 1392 conflitos de lock em 4000 operações concentradas em 4 wallets quentes, sem nenhum erro e sem nenhuma divergência.

A coluna `version` continua sendo incrementada a cada mudança de saldo, como trilha de auditoria e para quem quiser cache condicional.

**Ordem de lock única, sem deadlock.** Toda escrita trava primeiro a wallet: HTTP, fila e worker de PENDING_REFERENCE. O worker só depois trava a própria transação pendente, com `FOR NO KEY UPDATE SKIP LOCKED`, que não bloqueia a verificação de FK de quem insere uma transação referenciando aquela linha.

**Conflito de lock medido com precisão.** O lock tenta `FOR UPDATE NOWAIT` dentro de um `SAVEPOINT`. Se outra transação segura a linha (SQLSTATE `55P03`), volta ao savepoint, conta o conflito e espera com `FOR UPDATE` normal. Sem contenção, custa só o savepoint.

**Leituras sem lock.** Consultas e reconciliação não travam nada. A reconciliação lê saldo e soma do ledger numa única instrução SQL, ou seja, num único snapshot. Como saldo e lançamento são confirmados juntos, ela nunca acusa divergência falsa durante o tráfego.

**Provas.** Os testes de concorrência rodam com paralelismo real: várias conexões num processo e também **3 processos `bun src/main.ts` simultâneos**, com SIGKILL e SIGTERM no meio. Retirando o lock da wallet, eles falham.

## Inbox e outbox

### Entrada pela fila (inbox)

```
receive ─► caso de uso (1 transação SQL: inbox + transação + ledger + saldo + outbox) ─► COMMIT ─► DeleteMessage (ACK)
```

- **ACK só depois do commit.** Se o processo morre entre o commit e o ACK, a mensagem volta. O inbox `(consumer_name, message_id)` mostra que ela já foi aplicada, e o caso de uso responde como replay, sem tocar na wallet. Esse cenário é testado com SIGKILL real.
- **Mesma transação em mensagens diferentes**, quando o provedor republica: a idempotência por chave e por `(providerId, externalTransactionId)` garante efeito único.
- **Classificação de erros.**

  | Tipo | Exemplos | Ação |
  |------|----------|------|
  | Resultado de negócio | processada, rejeitada, aguardando referência | ACK |
  | Erro permanente | JSON inválido, payload inválido, wallet inexistente, chave com payload divergente | DLQ imediata, com o código do erro |
  | Erro transitório ou desconhecido | — | visibilidade com backoff de 5s, 10s, 20s, 40s |

- **Limite de 5 entregas** (`maxReceiveCount`, depois o redrive da fila leva à DLQ). Essas 5 entregas cobrem cerca de 75s de indisponibilidade do PostgreSQL. Mais que isso travaria o grupo FIFO da wallet por tempo demais.
- **Ordem.** `MessageGroupId = walletId`. Se uma mensagem falha, as seguintes do mesmo grupo no lote ficam invisíveis pelo mesmo backoff, para nunca serem aplicadas antes dela.
- **SIGTERM.** O consumidor para de buscar, termina a mensagem em andamento e devolve a visibilidade das outras.

### Saída de eventos (outbox)

Os eventos (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged` só quando o saldo muda, e `WagerTransactionPendingReference`) entram no outbox **no mesmo commit** da transação. O `OutboxRelay` roda em toda instância:

```sql
SELECT ... FROM outbox_messages
 WHERE published_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= now())
   AND NOT EXISTS (evento anterior da mesma wallet em backoff)
 ORDER BY occurred_at, id LIMIT :batch
 FOR UPDATE SKIP LOCKED
```

Depois do `SELECT`, o relay publica, marca `published_at` ou agenda retry com backoff de 1s até 5 min, e faz `COMMIT`.

- **Sem duplicação entre workers.** Uma linha travada por um relay é pulada pelos outros.
- **Sem perda.** A linha só deixa de ser pendente no commit que grava `published_at`. Processo morto antes disso faz rollback, e outra instância publica.
- **Republicação segura.** O destino é `wager-events.fifo`, com `MessageGroupId = walletId` e `MessageDeduplicationId = eventId` (o id da linha do outbox). Uma republicação em até 5 minutos é descartada pela fila. Depois disso, o consumidor deduplica pelo `eventId` do envelope. O cenário "publica, morre antes do commit, outra instância republica" é testado com SIGKILL real.
- **Destino.** O enunciado só nomeia as filas de entrada. A fila de eventos foi a escolha mínima para cumprir a publicação.

## Algoritmo de `payloadHash`

`payloadHash = SHA-256 (hex)` do **JSON canônico** dos campos de negócio (`src/application/idempotency/payload-hash.ts`):

1. Campos: `providerId`, `externalTransactionId`, `walletId` e `playerId` (UUIDs em minúsculas), `roundId`, `gameId`, `kind`, `amount`, `currency` e `referenceExternalTransactionId` (ou `null`).
2. `amount` já normalizado pelo `Money`, com 2 casas: `"10"`, `"10.0"` e `"10.00"` geram o mesmo hash.
3. Chaves de objeto ordenadas recursivamente, sem espaços e strings com o escape do `JSON.stringify`.
4. A `idempotencyKey` **não** entra no hash: ela é a chave de busca, e o hash diz se o conteúdo é o mesmo.

Mesma chave e mesmo hash dão replay (`idempotentReplay: true`). Mesma chave com hash diferente dá conflito: HTTP 409 `PAYLOAD_CONFLICT`, ou DLQ na fila. O hash é verificado também quando o replay é detectado por `(providerId, externalTransactionId)`.

## Taxonomia de `FailureCode`

Rejeições de negócio são resultados terminais: a transação fica `REJECTED` com o código, gera `WagerTransactionRejected`, responde 422 no HTTP e recebe ACK na fila.

| Código | Quando |
|--------|--------|
| `INSUFFICIENT_BALANCE` | BET ou outro débito maior que o saldo |
| `REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE` | REFUND ou ROLLBACK cujo débito deixaria saldo negativo (ex.: ROLLBACK de um WIN já gasto) |
| `REFERENCE_NOT_FOUND` | Referência não chegou dentro do TTL de PENDING_REFERENCE (seção 7.4) |
| `REFERENCE_ALREADY_REVERSED` | A referência já foi revertida por uma transação do mesmo tipo |
| `INVALID_REFERENCE_KIND` | Tipo de referência não permitido: REFUND só referencia BET; ROLLBACK referencia BET, WIN ou REFUND; WIN referencia BET |
| `REFERENCE_MISMATCH` | Referência de outro provedor, jogador, wallet ou rodada |
| `REFERENCE_NOT_PROCESSED` | A referência existe mas terminou REJECTED ou FAILED |
| `REFERENCE_AMOUNT_MISMATCH` | REFUND ou ROLLBACK com valor diferente da referência (sem reversão parcial) |
| `CURRENCY_MISMATCH` | Moeda diferente da wallet ou da referência |
| `PLAYER_MISMATCH` | `playerId` da transação diferente do dono da wallet |
| `PAYLOAD_CONFLICT` | Mesma chave de idempotência com payload diferente. É erro da requisição (HTTP 409, DLQ na fila), não um status REJECTED |
| `REFERENCE_EXPIRED` | Presente na lista do enunciado e reservado. A expiração usa `REFERENCE_NOT_FOUND`, como manda a seção 7.4 |

## PENDING_REFERENCE: backoff e TTL

REFUND, ROLLBACK ou WIN cuja referência ainda não chegou (ou ainda não foi processada) fica `PENDING_REFERENCE`, sem mover saldo. O `PendingReferenceWorker` reprocessa:

- **Backoff.** A primeira tentativa acontece no próximo ciclo (até 1s). Depois a espera é `min(2s × 2^(n-1), 5 min)`, ou seja 2s, 4s, 8s … 256s, e então a cada 5 minutos.
- **Limite: TTL de 24h desde a criação.** O agendamento nunca passa do vencimento. Ao vencer: `REJECTED` com `REFERENCE_NOT_FOUND` e `WagerTransactionRejected` no outbox.
- **Por que 24h, e por que TTL e não número de tentativas.** Esperar é financeiramente seguro: se a referência nunca chega, o débito ou crédito original também não aconteceu. A janela cobre a reordenação normal (segundos), o ciclo de retry da fila (cerca de 75s) e o reprocessamento manual da DLQ pela operação (horas). Para o negócio importa o tempo que a referência teve para chegar, não quantas vezes o worker olhou.
- **Estado persistido.** Duas colunas aditivas em `wager_transactions` guardam o agendamento: `reference_attempts` e `next_reference_attempt_at`, no mesmo padrão `attempts`/`next_attempt_at` do outbox. Backoff com várias instâncias exige esse estado no banco.
- **Mesmas regras da entrada.** A resolução usa o mesmo motor de regras. Referência inválida, já revertida ou que deixaria saldo negativo vira REJECTED com o código específico. Cadeias como ROLLBACK → REFUND → BET se resolvem em ciclos sucessivos.

## Observabilidade

- **Logs.** JSON em linha única via pino, compartilhado por Nest, Fastify, workers e MikroORM. Toda linha leva `correlationId`: vem do header `X-Correlation-Id` (validado) ou do atributo da mensagem SQS, ou então do `MessageId`. Linhas de transação levam `transactionId`, `walletId`, `providerId` e `messageId`. **Nenhum valor, saldo ou corpo** vai para o log, e um `redact` cobre deslizes. O SQL do ORM só aparece com `MIKRO_ORM_DEBUG=true`, porque ele interpola valores.
- **Métricas** (`GET /metrics`, Prometheus): transações por status e origem, duplicatas, conflitos de idempotência, retries (UNIQUE, fila, outbox, pendências), mensagens para a DLQ e profundidade da DLQ, conflitos e espera de lock, outbox pendente, lag e atraso de publicação, pendências de referência, reconciliações e latência de processamento e HTTP.
- **Health** (sem autenticação):

  | Rota | Comportamento |
  |------|---------------|
  | `/health/live` | Só o processo |
  | `/health/ready` | PostgreSQL e SQS com timeout de 2s. Responde 503 com o componente `down`, e também 503 durante o desligamento |

## Reconciliação

`POST /wallets/:walletId/reconciliation` compara o saldo armazenado com `Σ CREDIT − Σ DEBIT` do ledger, numa instrução, sem lock. A resposta traz `consistent`, os dois saldos, a diferença com sinal e a escala exata. Divergência gera log `warn` sem valores e a métrica `wallet_reconciliations_total{result="divergent"}`, e **nunca é corrigida** automaticamente.

## Autenticação

**Decisão: B — não implementar agora, deixar o ponto de extensão.**

O enunciado (seção 3) define que autenticação não vale pontos e não deve competir com as partes críticas (correção financeira, concorrência, idempotência, mensageria). Subir um IdP (Keycloak ou Zitadel) traria mais um serviço ao Docker Compose, configuração de realm/clients e emissão de tokens nos testes, sem melhorar nenhuma das garantias avaliadas. Por isso a API não exige credencial hoje, mas toda rota HTTP já passa por um guard cuja decisão é delegada a uma porta substituível.

### Peças

| Peça | Arquivo | Papel |
|------|---------|-------|
| `AuthGuard` | `src/infrastructure/http/auth/auth.guard.ts` | Guard global (`APP_GUARD`). Rotas marcadas com `@Public()` passam direto. As demais são decididas pelo `RequestAuthenticator`; recusa vira `401 {"error":"UNAUTHORIZED"}` |
| `RequestAuthenticator` | `src/infrastructure/http/auth/request-authenticator.ts` | Porta (token `REQUEST_AUTHENTICATOR`) que recebe os headers da requisição e responde se ela é autêntica. **É o ponto de extensão** |
| `NoopRequestAuthenticator` | mesmo arquivo | Implementação atual: aceita tudo |
| `@Public()` | `src/infrastructure/http/auth/public.decorator.ts` | Marca `/health/live`, `/health/ready` e `/metrics` |

### Como ligar um IdP

Basta registrar outra implementação de `RequestAuthenticator` no `AuthModule`, por exemplo uma que leia `Authorization: Bearer <jwt>` e valide assinatura, emissor, audiência e expiração contra o JWKS do Keycloak ou do Zitadel. Controllers, casos de uso e o próprio guard não mudam. O teste `test/integration/auth.spec.ts` faz exatamente essa troca com um autenticador de exemplo e comprova que as rotas de negócio passam a responder 401 sem credencial, enquanto health checks e métricas continuam abertos.

### Regras da seção 3

| Regra | Como é garantida |
|-------|------------------|
| `/health/*` ficam abertos | `@Public()` no `HealthController`. O guard libera antes de consultar o autenticador, então a regra continua valendo quando houver autenticação real |
| Mensagens da fila são canal interno confiável | O consumidor SQS não passa por guard HTTP. A confiança vem de quem tem acesso à fila (IAM e rede), não de credencial na mensagem |
| Identidade do provedor na mensagem segue as validações de domínio | `providerId` é obrigatório na validação do caso de uso, e uma referência só é aceita se pertencer ao mesmo provedor, jogador, wallet e rodada (seção 7.2). HTTP e fila usam o mesmo caso de uso, então a regra é idêntica nas duas entradas |

`/metrics` também é público para o Prometheus raspar sem credencial. A proteção esperada para ele é de rede: a porta não deve ser exposta publicamente.

## Trade-offs e limitações conhecidas

- **Wallet quente serializa.** O lock pessimista enfileira as operações de uma mesma wallet. É a escolha certa para correção, mas a vazão de uma única wallet fica limitada a uma transação SQL por vez.
- **Outbox atrás sob carga.** O relay publica uma mensagem por chamada ao SQS, em sequência por wallet, mantendo o lock das linhas durante a publicação. No teste de carga, o outbox chegou a cerca de 1650 eventos pendentes e 5s de lag, e drenou 3,5s depois do fim da carga. `SendMessageBatch` e lotes maiores são o próximo passo se o lag importar.
- **Ordem dos eventos.** Eventos da mesma transação SQL compartilham `occurredAt`, e a ordem entre eles não é definida. Dois relays numa corrida podem publicar eventos diferentes da mesma wallet ao mesmo tempo, pois o `NOT EXISTS` só impede ultrapassar um evento em backoff. Consumidores devem ordenar por `occurredAt` e deduplicar por `eventId`.
- **FIFO por wallet na entrada.** Uma mensagem com erro transitório trava o grupo da wallet durante o backoff, de até cerca de 75s, antes de ir para a DLQ.
- **DLQ sem ferramenta própria.** O reprocessamento é manual (redrive do SQS). Não há endpoint nem tela para isso.
- **Extensões aditivas do schema** em relação à lista do enunciado: a fila `wager-events.fifo`, o índice do outbox e as duas colunas de agendamento de PENDING_REFERENCE. Nenhuma coluna listada foi alterada.
- **Migrations manuais.** Elas não rodam no boot. Até serem aplicadas, os workers registram erro a cada ciclo e se recuperam sozinhos depois.
- **LocalStack sem persistência.** Reiniciar o container recria as filas vazias, e mensagens em trânsito são perdidas. No AWS real isso não acontece.
- **Autenticação.** Não implementada (decisão B), e `/metrics` depende de proteção de rede.
- **Opcionais não feitos.** OpenTelemetry e dashboard Grafana/Prometheus.
- **Pool padrão.** O MikroORM usa o pool padrão (10 conexões por instância). Em produção ele deve ser dimensionado junto com o `max_connections` do PostgreSQL e o número de instâncias.
