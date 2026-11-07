import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Message } from '@aws-sdk/client-sqs';
import { createTestDatabase, TestDatabase } from './support/test-database';
import { command, newWallet, walletsOutOfBalance } from './support/fixtures';
import { createTestEventsQueue, sleep, TEST_AWS_ENDPOINT, TestEventsQueue, waitFor } from './support/test-queues';
import { MikroOrmOutboxStore } from '../../src/infrastructure/persistence/mikro-orm-outbox-store';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { OutboxRelay } from '../../src/infrastructure/messaging/outbox-relay';
import { MessagingModule } from '../../src/infrastructure/messaging/messaging.module';
import { PublishOutboxBatchUseCase } from '../../src/application/use-cases/publish-outbox-batch.use-case';
import { EventPublisher, OutboxStore } from '../../src/application/ports/outbox.port';
import { ConsumerLogger } from '../../src/infrastructure/messaging/sqs-wager-consumer';

const silent: ConsumerLogger = { log() {}, warn() {}, error() {} };

let db: TestDatabase;
let store: MikroOrmOutboxStore;
const cleanup: Array<() => Promise<void>> = [];

beforeAll(async () => {
  db = await createTestDatabase('outbox');
  store = new MikroOrmOutboxStore(db.orm);
});

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
  // Cada teste termina com o outbox todo publicado: nenhum evento confirmado fica para trás
  expect(await pending()).toEqual([]);
});

afterAll(async () => {
  try {
    if (db) expect(await walletsOutOfBalance(db)).toEqual([]);
  } finally {
    await db?.destroy();
  }
});

async function eventsQueue(): Promise<TestEventsQueue> {
  const q = await createTestEventsQueue('outbox');
  cleanup.push(() => q.destroy());
  return q;
}

const pending = async () =>
  (await db.sql<{ id: string }>(`select id from outbox_messages where published_at is null order by occurred_at, id`)).map((r) => r.id);

const outboxOf = (walletId: string) =>
  db.sql<{ id: string; event_type: string; attempts: number; published_at: Date | null; due_later: boolean }>(
    `select id, event_type, attempts, published_at, coalesce(next_attempt_at > now(), false) as due_later
       from outbox_messages where aggregate_id = ? order by occurred_at, id`,
    [walletId],
  );

/** Publisher SQS real, registrando cada envio (o FIFO deduplica e esconderia publicações repetidas). */
function countingPublisher(q: TestEventsQueue, failFirstFor: Set<string> = new Set()) {
  const real = new SqsEventPublisher(q.sqs, q.url);
  const sent: string[] = [];
  const failed = new Set<string>();
  const p: EventPublisher & { sent: string[] } = {
    sent,
    async publish(m) {
      if (failFirstFor.has(m.id) && !failed.has(m.id)) {
        failed.add(m.id);
        throw new Error('simulated broker outage');
      }
      await real.publish(m);
      sent.push(m.id);
    },
  };
  return p;
}

function relay(publisher: EventPublisher, batchSize = 50, outboxStore: OutboxStore = store) {
  const r = new OutboxRelay(new PublishOutboxBatchUseCase(outboxStore, publisher), { batchSize, pollIntervalMs: 50, errorPauseMs: 50 }, silent);
  cleanup.push(() => r.stop());
  return r;
}

const eventIdOf = (m: Message) => JSON.parse(m.Body!).eventId as string;

/** Wallet com saldo inicial e `bets` apostas: 2 eventos de abertura + 2 por aposta. */
async function walletWithBets(bets: number) {
  const w = await newWallet(db, '100.00');
  for (let i = 0; i < bets; i++) await db.processTransaction.execute(command(w, 'BET', '1.00'));
  return w;
}

describe('Outbox publisher — publicação', () => {
  it('publica os pendentes com envelope, grupo = wallet e dedup = eventId, e marca published_at', async () => {
    const q = await eventsQueue();
    const w = await walletWithBets(1);
    const rows = await outboxOf(w.id);
    expect(rows.map((r) => r.event_type).sort()).toEqual([
      'WagerTransactionProcessed',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WalletBalanceChanged',
    ]);

    const r = await relay(countingPublisher(q)).runOnce();
    expect(r).toMatchObject({ claimed: 4, published: 4, failed: 0 });

    const after = await outboxOf(w.id);
    expect(after.every((x) => x.published_at !== null && x.attempts === 0)).toBe(true);

    const msgs = await q.drain();
    expect(msgs.map(eventIdOf)).toEqual(rows.map((x) => x.id)); // ordem do outbox dentro do grupo
    for (const m of msgs) {
      const body = JSON.parse(m.Body!);
      expect(body).toMatchObject({ aggregateId: w.id, version: 1 });
      expect(Object.keys(body).sort()).toEqual(['aggregateId', 'eventId', 'eventType', 'occurredAt', 'payload', 'version']);
      expect(m.Attributes?.MessageGroupId).toBe(w.id);
      expect(m.Attributes?.MessageDeduplicationId).toBe(body.eventId);
      expect(m.MessageAttributes?.eventType?.StringValue).toBe(body.eventType);
    }
  });

  it('LOSS e rejeição também geram eventos (WagerTransactionProcessed / WagerTransactionRejected) e são publicados', async () => {
    const q = await eventsQueue();
    const w = await newWallet(db, '10.00');
    await db.processTransaction.execute(command(w, 'LOSS', '0'));
    await db.processTransaction.execute(command(w, 'BET', '50.00'));

    await relay(countingPublisher(q)).runOnce();
    // Eventos da mesma transação compartilham occurredAt: a ordem entre eles não é definida
    const types = (await q.drain()).map((m) => JSON.parse(m.Body!).eventType).sort();
    expect(types).toEqual(['WagerTransactionProcessed', 'WagerTransactionProcessed', 'WagerTransactionRejected', 'WalletBalanceChanged']);
  });
});

describe('Outbox publisher — cenário crítico (seção 11)', () => {
  it('commit confirmado e processo morto antes de publicar: outra instância assume e publica', async () => {
    const q = await eventsQueue();
    const w = await walletWithBets(1);

    // Instância A reivindica o lote e morre antes de publicar → rollback, locks liberados
    await expect(store.processDue(50, async () => { throw new Error('process killed'); })).rejects.toThrow('process killed');
    expect(await pending()).toHaveLength(4);

    // Instância B assume
    const r = await relay(countingPublisher(q)).runOnce();
    expect(r.published).toBe(4);
    expect((await q.drain()).map(eventIdOf).sort()).toEqual((await outboxOf(w.id)).map((x) => x.id).sort());
  });

  it('processo publica e morre antes do commit: a outra instância republica com o mesmo eventId e a duplicata é absorvida', async () => {
    const q = await eventsQueue();
    const w = await walletWithBets(2);
    const ids = (await outboxOf(w.id)).map((x) => x.id);

    const publisherA = countingPublisher(q);
    const crashingStore: OutboxStore = {
      processDue: (limit, work) =>
        store.processDue(limit, async (msgs, now) => {
          await work(msgs, now); // publica no SQS...
          throw new Error('process killed before commit'); // ...e morre antes do commit
        }),
    };
    await expect(relay(publisherA, 50, crashingStore).runOnce()).rejects.toThrow('process killed before commit');
    expect(publisherA.sent.sort()).toEqual([...ids].sort());
    expect(await pending()).toHaveLength(ids.length); // nada foi marcado

    const publisherB = countingPublisher(q);
    await relay(publisherB).runOnce();
    expect(publisherB.sent.sort()).toEqual([...ids].sort()); // publicado de novo, mesmos eventIds

    // A fila FIFO descarta a republicação (MessageDeduplicationId = eventId): cada evento chega uma vez
    const received = (await q.drain()).map(eventIdOf);
    expect(received.sort()).toEqual([...ids].sort());
  });
});

describe('Outbox publisher — concorrência', () => {
  it('3 publishers concorrentes sobre o mesmo outbox: cada evento publicado exatamente uma vez', async () => {
    const q = await eventsQueue();
    const wallets = await Promise.all(Array.from({ length: 10 }, () => walletWithBets(3)));
    const expected = (await pending()).sort();
    expect(expected).toHaveLength(wallets.length * 8);

    const publishers = [countingPublisher(q), countingPublisher(q), countingPublisher(q)];
    const relays = publishers.map((p) => relay(p, 7));
    await Promise.all(
      relays.map(async (r) => {
        while ((await pending()).length > 0) await r.runOnce();
      }),
    );

    const sent = publishers.flatMap((p) => p.sent);
    expect(sent).toHaveLength(expected.length); // nenhum envio duplicado entre workers
    expect([...sent].sort()).toEqual(expected);
    expect(publishers.filter((p) => p.sent.length > 0).length).toBeGreaterThanOrEqual(2);
    expect((await q.drain()).map(eventIdOf).sort()).toEqual(expected);
  }, 30_000);

  it('SKIP LOCKED: linhas reivindicadas por um publisher lento são puladas pelo outro, que não espera', async () => {
    const q = await eventsQueue();
    await walletWithBets(0);
    await walletWithBets(0);
    const all = await pending();
    expect(all).toHaveLength(4);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let claimedBySlow: string[] = [];
    const real = countingPublisher(q);
    const slow: EventPublisher = {
      async publish(m) {
        claimedBySlow.push(m.id);
        await gate; // segura o lock da linha
        await real.publish(m);
      },
    };
    const slowRun = relay(slow, 1).runOnce();
    await waitFor(async () => claimedBySlow.length === 1);

    const fast = countingPublisher(q);
    const t0 = Date.now();
    const r = await relay(fast).runOnce();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.published).toBe(3);
    expect(fast.sent).not.toContain(claimedBySlow[0]);

    release();
    expect((await slowRun).published).toBe(1);
    expect([...fast.sent, ...real.sent].sort()).toEqual([...all].sort());
    await q.drain();
  });
});

describe('Outbox publisher — falhas e backoff', () => {
  it('falha de publicação agenda retry com backoff exponencial e não deixa a wallet ser ultrapassada', async () => {
    const q = await eventsQueue();
    const w = await walletWithBets(1);
    const other = await walletWithBets(0);
    const ids = (await outboxOf(w.id)).map((x) => x.id);

    const publisher = countingPublisher(q, new Set([ids[0]]));
    const rl = relay(publisher);

    const r1 = await rl.runOnce();
    expect(r1).toMatchObject({ failed: 1, deferred: 3, published: 2 }); // só a outra wallet saiu
    let rows = await outboxOf(w.id);
    expect(rows[0]).toMatchObject({ attempts: 1, published_at: null, due_later: true });
    expect(rows.slice(1).every((x) => x.attempts === 0 && x.published_at === null)).toBe(true);
    expect((await outboxOf(other.id)).every((x) => x.published_at !== null)).toBe(true);

    // Durante o backoff nada da wallet é reivindicado: o primeiro não está devido e os seguintes não podem passar à frente
    expect((await rl.runOnce()).claimed).toBe(0);

    await sleep(1100); // backoff da 1ª tentativa = 1s
    expect((await rl.runOnce()).published).toBe(4);
    rows = await outboxOf(w.id);
    expect(rows.every((x) => x.published_at !== null)).toBe(true);

    const group = (await q.drain()).filter((m) => m.Attributes?.MessageGroupId === w.id).map(eventIdOf);
    expect(group).toEqual(ids); // ordem da wallet preservada
  });

  it('broker indisponível: todas as tentativas falham, nada é perdido e tudo sai quando ele volta', async () => {
    const q = await eventsQueue();
    await walletWithBets(1);
    const before = await pending();

    const down: EventPublisher = { publish: async () => { throw new Error('ECONNREFUSED'); } };
    const r = await relay(down).runOnce();
    expect(r.published).toBe(0);
    expect(await pending()).toEqual(before);

    await sleep(1100);
    const up = countingPublisher(q);
    await relay(up).runOnce();
    expect(up.sent.sort()).toEqual([...before].sort());
    await q.drain();
  });
});

describe('Outbox publisher — ciclo de vida', () => {
  it('start() publica em segundo plano; stop() termina o ciclo em andamento e para', async () => {
    const q = await eventsQueue();
    const rl = relay(countingPublisher(q));
    rl.start();
    await walletWithBets(1);
    await waitFor(async () => (await pending()).length === 0);
    await rl.stop();

    await walletWithBets(0); // depois do stop nada mais é publicado
    await sleep(200);
    expect(await pending()).toHaveLength(2);
    await relay(countingPublisher(q)).runOnce();
    expect(await q.drain()).toHaveLength(6);
  });

  it('o MessagingModule inicia o publisher no bootstrap e o encerra no shutdown da app Nest', async () => {
    const q = await eventsQueue();
    const env = {
      SQS_EVENTS_QUEUE_URL: q.url,
      AWS_ENDPOINT: TEST_AWS_ENDPOINT,
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
      SQS_CONSUMER_ENABLED: 'false',
      OUTBOX_PUBLISHER_ENABLED: 'true',
      PENDING_REFERENCE_WORKER_ENABLED: 'false',
      OUTBOX_POLL_INTERVAL_MS: '50',
    };
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);

    let app: TestingModule | undefined;
    try {
      app = await Test.createTestingModule({ imports: [MikroOrmModule.forRoot(db.options), MessagingModule] }).compile();
      app.useLogger(false);
      await app.init();

      const w = await walletWithBets(1);
      await waitFor(async () => (await pending()).length === 0);
      const msgs = await q.drain();
      expect(msgs.map(eventIdOf).sort()).toEqual((await outboxOf(w.id)).map((x) => x.id).sort());
    } finally {
      await app?.close();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
