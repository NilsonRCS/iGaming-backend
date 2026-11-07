import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { randomUUID } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { createTestDatabase, TestDatabase } from './support/test-database';
import { balanceOf, command, ledgerOf, newWallet, walletsOutOfBalance } from './support/fixtures';
import { createTestQueues, sleep, TEST_AWS_ENDPOINT, TestQueues, waitFor } from './support/test-queues';
import { ConsumerLogger, SqsWagerConsumer, WagerTransactionProcessor } from '../../src/infrastructure/messaging/sqs-wager-consumer';
import { SqsConsumerConfig } from '../../src/infrastructure/messaging/sqs.config';
import { MessagingModule } from '../../src/infrastructure/messaging/messaging.module';
import { TransientInfrastructureError } from '../../src/application/errors';
import { ProcessWagerTransactionCommand } from '../../src/application/use-cases/process-wager-transaction.use-case';

const CONSUMER = 'wager-processor-test';
const silent: ConsumerLogger = { log() {}, warn() {}, error() {} };

let db: TestDatabase;
const cleanup: Array<() => Promise<void>> = [];

beforeAll(async () => {
  db = await createTestDatabase('consumer');
});

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

afterAll(async () => {
  try {
    if (db) expect(await walletsOutOfBalance(db)).toEqual([]);
  } finally {
    await db?.destroy();
  }
});

async function queues(opts?: { maxReceiveCount?: number; visibilityTimeout?: number }): Promise<TestQueues> {
  const q = await createTestQueues('consumer', opts);
  cleanup.push(() => q.destroy());
  return q;
}

function consumer(q: TestQueues, processor: WagerTransactionProcessor = db.processTransaction, config: Partial<SqsConsumerConfig> = {}) {
  const c = new SqsWagerConsumer(
    q.sqs,
    processor,
    {
      queueUrl: q.queueUrl,
      dlqUrl: q.dlqUrl,
      consumerName: CONSUMER,
      waitTimeSeconds: 1,
      maxMessages: 10,
      backoffBaseSeconds: 1,
      backoffMaxSeconds: 4,
      ...config,
    },
    silent,
  );
  cleanup.push(() => c.stop());
  return c;
}

/** Mensagem no formato do enunciado: corpo da API HTTP + idempotencyKey. */
function message(cmd: ProcessWagerTransactionCommand) {
  return {
    idempotencyKey: cmd.idempotencyKey,
    providerId: cmd.providerId,
    externalTransactionId: cmd.externalTransactionId,
    walletId: cmd.walletId,
    playerId: cmd.playerId,
    roundId: cmd.roundId,
    gameId: cmd.gameId,
    kind: cmd.kind,
    money: { amount: cmd.amount, currency: cmd.currency },
    referenceExternalTransactionId: cmd.referenceExternalTransactionId ?? null,
  };
}

const txByExternalId = (externalId: string) =>
  db.sql<{ id: string; status: string; failure_code: string | null }>(
    `select id, status, failure_code from wager_transactions where external_transaction_id = ?`,
    [externalId],
  );
const inboxOf = (messageId: string) =>
  db.sql<{ consumer_name: string; processed_at: Date | null }>(
    `select consumer_name, processed_at from inbox_messages where message_id = ?`,
    [messageId],
  );
const empty = async (q: TestQueues, url: string) => {
  const c = await q.count(url);
  return c.visible === 0 && c.inFlight === 0;
};

/** Falha com erro transitório nas primeiras `failures` chamadas, depois delega ao use case real. */
function flaky(failures: number) {
  let calls = 0;
  const processor: WagerTransactionProcessor & { calls: () => number } = {
    calls: () => calls,
    async execute(cmd) {
      calls++;
      if (calls <= failures) throw new TransientInfrastructureError('simulated: connection refused');
      return db.processTransaction.execute(cmd);
    },
  };
  return processor;
}

describe('SqsWagerConsumer — processamento e ACK', () => {
  it('BET da fila usa o mesmo use case: debita, grava o inbox na mesma transação e faz ACK após o commit', async () => {
    const q = await queues();
    const w = await newWallet(db, '100.00');
    const bet = command(w, 'BET', '25.00');
    const messageId = await q.send(message(bet), w.id);

    expect(await consumer(q).pollOnce()).toBe(1);

    expect(await balanceOf(db, w.id)).toBe('75.00');
    expect(await txByExternalId(bet.externalTransactionId)).toMatchObject([{ status: 'PROCESSED' }]);
    const [inbox] = await inboxOf(messageId);
    expect(inbox.consumer_name).toBe(CONSUMER);
    expect(inbox.processed_at).not.toBeNull();
    expect(await empty(q, q.queueUrl)).toBe(true);
    expect(await empty(q, q.dlqUrl)).toBe(true);
  });

  it('rejeição de negócio (saldo insuficiente) é terminal: transação REJECTED, ACK e nada na DLQ', async () => {
    const q = await queues();
    const w = await newWallet(db, '10.00');
    const bet = command(w, 'BET', '50.00');
    await q.send(message(bet), w.id);

    await consumer(q).pollOnce();

    expect(await txByExternalId(bet.externalTransactionId)).toMatchObject([{ status: 'REJECTED', failure_code: 'INSUFFICIENT_BALANCE' }]);
    expect(await balanceOf(db, w.id)).toBe('10.00');
    expect(await empty(q, q.queueUrl)).toBe(true);
    expect(await empty(q, q.dlqUrl)).toBe(true);
  });

  it('referência ausente fica PENDING_REFERENCE e também recebe ACK', async () => {
    const q = await queues();
    const w = await newWallet(db, '100.00');
    const refund = command(w, 'REFUND', '5.00', { referenceExternalTransactionId: `missing-${randomUUID()}` });
    await q.send(message(refund), w.id);

    await consumer(q).pollOnce();

    expect(await txByExternalId(refund.externalTransactionId)).toMatchObject([{ status: 'PENDING_REFERENCE' }]);
    expect(await empty(q, q.queueUrl)).toBe(true);
  });

  it('mensagens da mesma wallet são aplicadas na ordem da fila (BET, depois WIN, depois REFUND do BET)', async () => {
    const q = await queues();
    const w = await newWallet(db, '100.00');
    const bet = command(w, 'BET', '30.00');
    const win = command(w, 'WIN', '50.00', { referenceExternalTransactionId: bet.externalTransactionId });
    const bet2 = command(w, 'BET', '10.00');
    const refund = command(w, 'REFUND', '10.00', { referenceExternalTransactionId: bet2.externalTransactionId });
    for (const c of [bet, win, bet2, refund]) await q.send(message(c), w.id);

    const c = consumer(q);
    await waitFor(async () => (await c.pollOnce(), await empty(q, q.queueUrl)));

    expect(await balanceOf(db, w.id)).toBe('120.00');
    for (const x of [bet, win, bet2, refund]) {
      expect(await txByExternalId(x.externalTransactionId)).toMatchObject([{ status: 'PROCESSED' }]);
    }
  });
});

describe('SqsWagerConsumer — redelivery sem duplicar efeitos', () => {
  it('processo morre depois do commit e antes do ACK: a mensagem volta e o inbox faz replay sem novo débito', async () => {
    const q = await queues();
    const w = await newWallet(db, '100.00');
    const bet = command(w, 'BET', '40.00');
    await q.send(message(bet), w.id);

    // 1ª entrega: commit com o inbox, mas o "processo morre" antes do DeleteMessage
    const [first] = await q.peek(q.queueUrl, 1);
    await db.processTransaction.execute({ ...bet, inbox: { consumerName: CONSUMER, messageId: first.MessageId! } });
    expect(await balanceOf(db, w.id)).toBe('60.00');

    // Visibilidade expira; outra instância recebe a mesma mensagem (mesmo MessageId)
    await sleep(1500);
    const replays: unknown[] = [];
    const spy: WagerTransactionProcessor = {
      async execute(cmd) {
        const r = await db.processTransaction.execute(cmd);
        replays.push(r.idempotentReplay);
        return r;
      },
    };
    expect(await consumer(q, spy).pollOnce()).toBe(1);

    expect(replays).toEqual([true]);
    expect(await balanceOf(db, w.id)).toBe('60.00');
    expect(await ledgerOf(db, w.id)).toHaveLength(2); // OPENING + 1 débito
    expect(await inboxOf(first.MessageId!)).toHaveLength(1);
    expect(await empty(q, q.queueUrl)).toBe(true);
  });

  it('mesma transação publicada duas vezes (MessageIds distintos) tem um único efeito', async () => {
    const q = await queues();
    const w = await newWallet(db, '100.00');
    const bet = command(w, 'BET', '15.00');
    const m1 = await q.send(message(bet), w.id);
    const m2 = await q.send(message(bet), w.id);

    const c = consumer(q);
    await waitFor(async () => (await c.pollOnce(), await empty(q, q.queueUrl)));

    expect(await balanceOf(db, w.id)).toBe('85.00');
    expect(await txByExternalId(bet.externalTransactionId)).toHaveLength(1);
    expect(await inboxOf(m1)).toHaveLength(1);
    expect(await inboxOf(m2)).toHaveLength(1);
  });
});

describe('SqsWagerConsumer — erros permanentes vão para a DLQ', () => {
  it.each([
    ['JSON malformado', () => '{not json', 'INVALID_PAYLOAD'],
    ['valor monetário como número', (b: Record<string, unknown>) => ({ ...b, money: { amount: 10, currency: 'BRL' } }), 'INVALID_PAYLOAD'],
    ['sem idempotencyKey', (b: Record<string, unknown>) => ({ ...b, idempotencyKey: undefined }), 'INVALID_PAYLOAD'],
    ['wallet inexistente', (b: Record<string, unknown>) => ({ ...b, walletId: randomUUID() }), 'WALLET_NOT_FOUND'],
  ])('%s → DLQ imediata com o código do erro, sem efeito no banco', async (_, mutate, errorCode) => {
    const q = await queues();
    const w = await newWallet(db, '100.00');
    const bet = command(w, 'BET', '5.00');
    const body = mutate(message(bet) as unknown as Record<string, unknown>);
    const messageId = await q.send(body, w.id);

    await consumer(q).pollOnce();

    expect(await empty(q, q.queueUrl)).toBe(true);
    const [dead] = await q.peek(q.dlqUrl);
    expect(dead.Body).toBe(typeof body === 'string' ? body : JSON.stringify(body));
    expect(dead.MessageAttributes?.errorCode?.StringValue).toBe(errorCode);
    expect(dead.MessageAttributes?.originalMessageId?.StringValue).toBe(messageId);
    expect(await txByExternalId(bet.externalTransactionId)).toHaveLength(0);
    expect(await inboxOf(messageId)).toHaveLength(0);
    expect(await balanceOf(db, w.id)).toBe('100.00');
  });

  it('mesma chave de idempotência com payload divergente → DLQ (PAYLOAD_CONFLICT), primeira aplicação intacta', async () => {
    const q = await queues();
    const w = await newWallet(db, '100.00');
    const bet = command(w, 'BET', '20.00');
    await q.send(message(bet), w.id);
    await q.send(message({ ...bet, amount: '99.00' }), w.id);

    const c = consumer(q);
    await waitFor(async () => (await c.pollOnce(), await empty(q, q.queueUrl)));

    expect(await balanceOf(db, w.id)).toBe('80.00');
    const [dead] = await q.peek(q.dlqUrl);
    expect(dead.MessageAttributes?.errorCode?.StringValue).toBe('PAYLOAD_CONFLICT');
  });
});

describe('SqsWagerConsumer — erros transitórios: retry com backoff', () => {
  it('falha transitória devolve a mensagem com backoff; a nova entrega processa uma única vez', async () => {
    const q = await queues();
    const w = await newWallet(db, '100.00');
    const bet = command(w, 'BET', '12.00');
    await q.send(message(bet), w.id);
    const processor = flaky(1);
    const c = consumer(q, processor, { waitTimeSeconds: 0, backoffBaseSeconds: 2 });

    await c.pollOnce();
    expect(await balanceOf(db, w.id)).toBe('100.00');
    // Durante o backoff a mensagem fica invisível (não é reentregue de imediato)
    expect(await c.pollOnce()).toBe(0);
    expect(await q.count(q.queueUrl)).toEqual({ visible: 0, inFlight: 1 });

    await waitFor(async () => (await c.pollOnce(), await empty(q, q.queueUrl)), 6000);
    expect(processor.calls()).toBe(2);
    expect(await balanceOf(db, w.id)).toBe('88.00');
    expect(await empty(q, q.dlqUrl)).toBe(true);
  }, 15_000);

  it('falha transitória persistente: após maxReceiveCount entregas o redrive da fila leva à DLQ', async () => {
    const q = await queues({ maxReceiveCount: 3 });
    const w = await newWallet(db, '100.00');
    const bet = command(w, 'BET', '7.00');
    const messageId = await q.send(message(bet), w.id);
    const processor = flaky(Number.POSITIVE_INFINITY);
    const c = consumer(q, processor, { waitTimeSeconds: 0, backoffBaseSeconds: 1, backoffMaxSeconds: 1 });

    await waitFor(async () => {
      await c.pollOnce();
      return (await q.count(q.dlqUrl)).visible === 1;
    }, 15_000, 300);

    expect(processor.calls()).toBe(3);
    expect(await empty(q, q.queueUrl)).toBe(true);
    const [dead] = await q.peek(q.dlqUrl);
    expect(dead.MessageId).toBe(messageId);
    expect(await balanceOf(db, w.id)).toBe('100.00');
  }, 20_000);

  it('falha numa wallet devolve as mensagens seguintes do mesmo grupo e não trava outras wallets', async () => {
    const q = await queues();
    const a = await newWallet(db, '100.00');
    const b = await newWallet(db, '100.00');
    const betA1 = command(a, 'BET', '10.00');
    const betA2 = command(a, 'BET', '20.00');
    const betB = command(b, 'BET', '30.00');
    await q.send(message(betA1), a.id);
    await q.send(message(betA2), a.id);
    await q.send(message(betB), b.id);

    // Falha só na primeira mensagem da wallet A
    let failed = false;
    const processor: WagerTransactionProcessor = {
      async execute(cmd) {
        if (!failed && cmd.externalTransactionId === betA1.externalTransactionId) {
          failed = true;
          throw new TransientInfrastructureError('simulated');
        }
        return db.processTransaction.execute(cmd);
      },
    };
    const c = consumer(q, processor, { waitTimeSeconds: 0, backoffBaseSeconds: 1 });

    // Até B ser processada, A2 nunca pode ter sido aplicada antes de A1
    await waitFor(async () => (await c.pollOnce(), (await txByExternalId(betB.externalTransactionId)).length === 1));
    if ((await txByExternalId(betA1.externalTransactionId)).length === 0) {
      expect(await txByExternalId(betA2.externalTransactionId)).toHaveLength(0);
    }

    await waitFor(async () => (await c.pollOnce(), await empty(q, q.queueUrl)), 8000);
    const [a1] = await txByExternalId(betA1.externalTransactionId);
    const [a2] = await txByExternalId(betA2.externalTransactionId);
    const [seq1] = await db.sql<{ n: string }>(`select created_at::text as n from wager_transactions where id = ?`, [a1.id]);
    const [seq2] = await db.sql<{ n: string }>(`select created_at::text as n from wager_transactions where id = ?`, [a2.id]);
    expect(seq1.n < seq2.n).toBe(true);
    expect(await balanceOf(db, a.id)).toBe('70.00');
    expect(await balanceOf(db, b.id)).toBe('70.00');
  }, 15_000);
});

describe('SqsWagerConsumer — SIGTERM', () => {
  it('stop() termina a mensagem em andamento (commit + ACK) e devolve a visibilidade das não iniciadas', async () => {
    const q = await queues();
    const w = await newWallet(db, '100.00');
    const bets = [command(w, 'BET', '1.00'), command(w, 'BET', '2.00'), command(w, 'BET', '3.00')];
    for (const b of bets) await q.send(message(b), w.id);

    let started!: () => void;
    const inProgress = new Promise<void>((r) => (started = r));
    const processor: WagerTransactionProcessor = {
      async execute(cmd) {
        started();
        await sleep(500); // trabalho em andamento quando o SIGTERM chega
        return db.processTransaction.execute(cmd);
      },
    };
    const c = consumer(q, processor);
    c.start();
    await inProgress;
    await c.stop();

    // A primeira terminou e foi confirmada; as outras duas não foram aplicadas e voltaram para a fila
    expect(await txByExternalId(bets[0].externalTransactionId)).toHaveLength(1);
    expect(await txByExternalId(bets[1].externalTransactionId)).toHaveLength(0);
    expect(await txByExternalId(bets[2].externalTransactionId)).toHaveLength(0);
    expect(await q.count(q.queueUrl)).toEqual({ visible: 2, inFlight: 0 });

    // Outra instância assume e conclui
    const next = consumer(q);
    await waitFor(async () => (await next.pollOnce(), await empty(q, q.queueUrl)));
    expect(await balanceOf(db, w.id)).toBe('94.00');
  });

  it('o MessagingModule inicia o consumidor no bootstrap e o encerra no shutdown da app Nest', async () => {
    const q = await queues();
    const w = await newWallet(db, '100.00');
    const bet = command(w, 'BET', '9.00');

    const env = {
      SQS_QUEUE_URL: q.queueUrl,
      SQS_DLQ_URL: q.dlqUrl,
      SQS_CONSUMER_NAME: CONSUMER,
      SQS_WAIT_TIME_SECONDS: '1',
      AWS_ENDPOINT: TEST_AWS_ENDPOINT,
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
      SQS_CONSUMER_ENABLED: 'true',
      OUTBOX_PUBLISHER_ENABLED: 'false',
    };
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);

    let app: TestingModule | undefined;
    try {
      // Contexto de aplicação (sem HTTP): init() dispara onApplicationBootstrap, close() o shutdown.
      app = await Test.createTestingModule({
        imports: [MikroOrmModule.forRoot(db.options), MessagingModule],
      }).compile();
      app.useLogger(false);
      await app.init();

      await q.send(message(bet), w.id);
      await waitFor(async () => (await txByExternalId(bet.externalTransactionId)).length === 1);
      await waitFor(() => empty(q, q.queueUrl));
      expect(await balanceOf(db, w.id)).toBe('91.00');
    } finally {
      await app?.close();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
