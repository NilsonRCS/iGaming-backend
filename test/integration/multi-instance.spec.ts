import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'crypto';
import { createTestDatabase, TestDatabase } from './support/test-database';
import { walletsOutOfBalance } from './support/fixtures';
import { createTestEventsQueue, createTestQueues, sleep, TestEventsQueue, TestQueues, waitFor } from './support/test-queues';
import { AppInstance, countLogs, InstanceTopology, startInstance, sumLogField } from './support/app-instances';

/**
 * Seção 8 e 13.3 com PROCESSOS REAIS: cada instância é um `bun src/main.ts` separado,
 * com seu próprio pool de conexões, consumidor SQS e publisher do outbox.
 * PostgreSQL e LocalStack reais; banco e filas descartáveis por bloco.
 */

const PROVIDER = 'provider-a';
type Wallet = { id: string; playerId: string };

interface Env {
  db: TestDatabase;
  queues: TestQueues;
  events: TestEventsQueue;
  topology: InstanceTopology;
  instances: AppInstance[];
}

async function createEnv(label: string, opts: { instances?: number; overrides?: Record<string, string>[] } = {}): Promise<Env> {
  const db = await createTestDatabase(label);
  const queues = await createTestQueues(label, { visibilityTimeout: 3 });
  const events = await createTestEventsQueue(label);
  const topology = { db, queueUrl: queues.queueUrl, dlqUrl: queues.dlqUrl, eventsQueueUrl: events.url };
  const n = opts.instances ?? 3;
  const instances = await Promise.all(
    Array.from({ length: n }, (_, i) => startInstance(`${label}-${i + 1}`, topology, opts.overrides?.[i] ?? {})),
  );
  return { db, queues, events, topology, instances };
}

async function destroyEnv(env: Env | undefined, extra: AppInstance[] = []): Promise<void> {
  if (!env) return;
  try {
    expect(await walletsOutOfBalance(env.db)).toEqual([]);
  } finally {
    await Promise.all([...env.instances, ...extra].map((i) => i.stop('SIGKILL')));
    await env.queues.destroy();
    await env.events.destroy();
    await env.db.destroy();
  }
}

async function openWallet(app: AppInstance, amount = '100.00'): Promise<Wallet> {
  const r = await app.http('POST', '/wallets', { playerId: randomUUID(), initialBalance: { amount, currency: 'BRL' } });
  expect(r.status).toBe(201);
  return { id: r.body.id, playerId: r.body.playerId };
}

function tx(w: Wallet, kind: string, amount: string, extra: { ext?: string; ref?: string } = {}) {
  const externalTransactionId = extra.ext ?? `ext-${kind}-${randomUUID()}`;
  return {
    idempotencyKey: `${PROVIDER}:${externalTransactionId}`,
    providerId: PROVIDER,
    externalTransactionId,
    walletId: w.id,
    playerId: w.playerId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: { amount, currency: 'BRL' },
    referenceExternalTransactionId: extra.ref ?? null,
  };
}

function submit(app: AppInstance, body: ReturnType<typeof tx>) {
  const { idempotencyKey, ...payload } = body;
  return app.http('POST', '/wagering/transactions', payload, { 'idempotency-key': idempotencyKey });
}

/** Cliente resiliente: instância caiu → reenvia a mesma requisição (mesma chave) para outra. */
async function submitWithFailover(apps: AppInstance[], start: number, body: ReturnType<typeof tx>) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const app = apps[(start + attempt) % apps.length];
    if (!app.isAlive()) continue;
    try {
      const r = await submit(app, body);
      if (r.status < 500) return r;
    } catch {
      // conexão recusada/resetada: a instância morreu no meio
    }
    await sleep(100);
  }
  throw new Error(`no instance accepted ${body.externalTransactionId}`);
}

const balance = async (db: TestDatabase, walletId: string) =>
  (await db.sql<{ b: string }>(`select balance_amount::numeric(19,2)::text as b from wallets where id = ?`, [walletId]))[0].b;

const txRows = (db: TestDatabase, walletId: string) =>
  db.sql<{ kind: string; status: string; failure_code: string | null; external_transaction_id: string }>(
    `select kind, status, failure_code, external_transaction_id from wager_transactions where wallet_id = ? and kind <> 'OPENING'`,
    [walletId],
  );

const ledgerDirections = async (db: TestDatabase, walletId: string) =>
  (await db.sql<{ direction: string; amount: string }>(
    `select direction, money_amount::numeric(19,2)::text as amount from wallet_ledger_entries where wallet_id = ? order by created_at`,
    [walletId],
  )).slice(1); // sem o CREDIT de abertura

const pendingOutbox = async (db: TestDatabase) =>
  Number((await db.sql<{ n: string }>(`select count(*)::int as n from outbox_messages where published_at is null`))[0].n);

const queueDrained = async (q: TestQueues) => {
  const c = await q.count(q.queueUrl);
  return c.visible === 0 && c.inFlight === 0;
};

// ─────────────────────────────────────────────────────────────────────────────

describe('3 instâncias — HTTP', () => {
  let env: Env;
  beforeAll(async () => {
    env = await createEnv('mi_http');
  }, 60_000);
  afterAll(async () => {
    // Todos os eventos gerados foram publicados pelos 3 publishers
    await waitFor(async () => (await pendingOutbox(env.db)) === 0, 15_000);
    await destroyEnv(env);
  }, 60_000);

  it('seção 8: 100.00 e duas BETs de 80.00 simultâneas em instâncias diferentes (20 wallets)', async () => {
    const [a, b, c] = env.instances;
    const apps = [a, b, c];
    const wallets = await Promise.all(Array.from({ length: 20 }, (_, i) => openWallet(apps[i % 3])));

    await Promise.all(
      wallets.map((w, i) =>
        Promise.all([submit(apps[i % 3], tx(w, 'BET', '80.00')), submit(apps[(i + 1) % 3], tx(w, 'BET', '80.00'))]),
      ),
    );

    for (const w of wallets) {
      const rows = await txRows(env.db, w.id);
      expect(rows.map((r) => r.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
      expect(rows.find((r) => r.status === 'REJECTED')!.failure_code).toBe('INSUFFICIENT_BALANCE');
      expect(await balance(env.db, w.id)).toBe('20.00');
      expect(await ledgerDirections(env.db, w.id)).toEqual([{ direction: 'DEBIT', amount: '80.00' }]);
    }
  }, 60_000);

  it('mesma aposta enviada 50x em paralelo pelas 3 instâncias: um único débito', async () => {
    const w = await openWallet(env.instances[0]);
    const bet = tx(w, 'BET', '10.00');

    const responses = await Promise.all(Array.from({ length: 50 }, (_, i) => submit(env.instances[i % 3], bet)));

    const byStatus = responses.reduce<Record<number, number>>((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {});
    expect(byStatus).toEqual({ 201: 1, 200: 49 });
    expect(new Set(responses.map((r) => r.body.transaction.id)).size).toBe(1);
    expect(await txRows(env.db, w.id)).toHaveLength(1);
    expect(await ledgerDirections(env.db, w.id)).toEqual([{ direction: 'DEBIT', amount: '10.00' }]);
    expect(await balance(env.db, w.id)).toBe('90.00');
  }, 60_000);

  it('wallets distintas processadas em paralelo sem interferência (30 wallets × 5 apostas)', async () => {
    const wallets = await Promise.all(Array.from({ length: 30 }, (_, i) => openWallet(env.instances[i % 3], '200.00')));
    const amounts = (i: number) => [1, 2, 3, 4, 5].map((k) => ((i + k) % 9) + 1);

    const all = wallets.flatMap((w, i) => amounts(i).map((a, k) => ({ w, body: tx(w, 'BET', `${a}.00`), app: env.instances[(i + k) % 3] })));
    const responses = await Promise.all(all.map(({ app, body }) => submit(app, body)));
    expect(responses.every((r) => r.status === 201)).toBe(true);

    for (const [i, w] of wallets.entries()) {
      const spent = amounts(i).reduce((s, a) => s + a, 0);
      expect(await balance(env.db, w.id)).toBe(`${200 - spent}.00`);
      expect(await ledgerDirections(env.db, w.id)).toHaveLength(5);
    }
  }, 60_000);

  it('REFUND/ROLLBACK em paralelo com o próprio BET em instâncias diferentes: nunca crédito duplicado', async () => {
    const wallets = await Promise.all(Array.from({ length: 12 }, (_, i) => openWallet(env.instances[i % 3])));

    await Promise.all(
      wallets.map(async (w, i) => {
        const bet = tx(w, 'BET', '30.00');
        const reversal = tx(w, i % 2 ? 'REFUND' : 'ROLLBACK', '30.00', { ref: bet.externalTransactionId });
        await Promise.all([submit(env.instances[i % 3], bet), submit(env.instances[(i + 1) % 3], reversal)]);
      }),
    );

    for (const w of wallets) {
      const rows = await txRows(env.db, w.id);
      const bet = rows.find((r) => r.kind === 'BET')!;
      const rev = rows.find((r) => r.kind !== 'BET')!;
      expect(bet.status).toBe('PROCESSED');
      expect(['PROCESSED', 'PENDING_REFERENCE']).toContain(rev.status);
      const credits = (await ledgerDirections(env.db, w.id)).filter((l) => l.direction === 'CREDIT');
      // Reversão aplicada (BET chegou antes) → saldo restaurado; pendente (chegou antes do BET) → só o débito
      expect(credits).toHaveLength(rev.status === 'PROCESSED' ? 1 : 0);
      expect(await balance(env.db, w.id)).toBe(rev.status === 'PROCESSED' ? '100.00' : '70.00');
    }
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────

describe('3 instâncias — fila SQS', () => {
  let env: Env;
  beforeAll(async () => {
    env = await createEnv('mi_sqs');
  }, 60_000);
  afterAll(async () => {
    await waitFor(async () => (await pendingOutbox(env.db)) === 0, 15_000);
    await destroyEnv(env);
  }, 60_000);

  it('3 consumidores competindo pela mesma fila: cada mensagem aplicada uma vez, na ordem da wallet', async () => {
    const wallets = await Promise.all(Array.from({ length: 12 }, (_, i) => openWallet(env.instances[i % 3])));
    let messages = 0;
    for (const w of wallets) {
      const bet1 = tx(w, 'BET', '10.00');
      const win = tx(w, 'WIN', '25.00', { ref: bet1.externalTransactionId });
      const bet2 = tx(w, 'BET', '5.00');
      const refund = tx(w, 'REFUND', '5.00', { ref: bet2.externalTransactionId });
      for (const m of [bet1, win, bet2, refund]) {
        await env.queues.send(m, w.id);
        messages++;
      }
    }

    await waitFor(() => queueDrained(env.queues), 30_000, 250);

    for (const w of wallets) {
      const rows = await txRows(env.db, w.id);
      expect(rows).toHaveLength(4);
      expect(rows.every((r) => r.status === 'PROCESSED')).toBe(true);
      expect(await balance(env.db, w.id)).toBe('115.00');
    }
    const [{ n }] = await env.db.sql<{ n: number }>(`select count(*)::int as n from inbox_messages`);
    expect(n).toBe(messages);
    expect(await env.queues.count(env.queues.dlqUrl)).toEqual({ visible: 0, inFlight: 0 });
    // Trabalho de fato distribuído entre processos
    const workers = env.instances.filter((i) => countLogs(i, 'Message processed') > 0);
    expect(workers.length).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it('REFUND entregue antes do BET referenciado: fica PENDING_REFERENCE, sem crédito; o BET é aplicado', async () => {
    const w = await openWallet(env.instances[0]);
    const bet = tx(w, 'BET', '30.00');
    const refund = tx(w, 'REFUND', '30.00', { ref: bet.externalTransactionId });
    await env.queues.send(refund, w.id); // provedor entregou fora de ordem
    await env.queues.send(bet, w.id);

    await waitFor(async () => (await txRows(env.db, w.id)).length === 2 && (await queueDrained(env.queues)), 15_000);

    const rows = await txRows(env.db, w.id);
    expect(rows.find((r) => r.kind === 'REFUND')!.status).toBe('PENDING_REFERENCE');
    expect(rows.find((r) => r.kind === 'BET')!.status).toBe('PROCESSED');
    expect(await ledgerDirections(env.db, w.id)).toEqual([{ direction: 'DEBIT', amount: '30.00' }]);
    expect(await balance(env.db, w.id)).toBe('70.00');
    const types = await env.db.sql<{ event_type: string }>(`select event_type from outbox_messages where aggregate_id = ?`, [w.id]);
    expect(types.map((t) => t.event_type)).toContain('WagerTransactionPendingReference');
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Processo morto (SIGKILL) depois do commit e antes do ACK', () => {
  let env: Env;
  const later: AppInstance[] = [];
  beforeAll(async () => {
    // Só a instância com falha injetada consome no início
    env = await createEnv('mi_kill_ack', { instances: 1, overrides: [{ CHAOS_KILL_AFTER_COMMIT: '1' }] });
  }, 60_000);
  afterAll(async () => destroyEnv(env, later), 60_000);

  it('a mensagem volta para outra instância, o inbox faz replay e o débito acontece uma vez', async () => {
    const [chaos] = env.instances;
    const w = await openWallet(chaos);
    const bet = tx(w, 'BET', '40.00');
    const messageId = await env.queues.send(bet, w.id);

    // Commit feito, processo morto antes do DeleteMessage
    const death = await chaos.exited;
    expect(death.signal).toBe('SIGKILL');
    expect(await balance(env.db, w.id)).toBe('60.00');
    expect(await env.queues.count(env.queues.queueUrl)).toMatchObject({ inFlight: 1 });

    // Duas instâncias novas assumem; a mensagem reaparece após o visibility timeout
    later.push(...(await Promise.all([startInstance('mi_kill_ack-2', env.topology), startInstance('mi_kill_ack-3', env.topology)])));
    await waitFor(() => queueDrained(env.queues), 20_000, 250);

    expect(await balance(env.db, w.id)).toBe('60.00');
    expect(await ledgerDirections(env.db, w.id)).toEqual([{ direction: 'DEBIT', amount: '40.00' }]);
    expect(await env.db.sql(`select 1 from inbox_messages where message_id = ?`, [messageId])).toHaveLength(1);
    const replayLogs = later.map((i) => i.logs()).join('\n');
    expect(replayLogs).toContain(`"messageId":"${messageId}","receiveCount":2`);
    expect(replayLogs).toMatch(/"idempotentReplay":true/);
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Publishers concorrentes sobre a mesma outbox, com um morto entre publicar e commitar', () => {
  let env: Env;
  const later: AppInstance[] = [];
  beforeAll(async () => {
    env = await createEnv('mi_outbox', {
      instances: 1,
      overrides: [{ CHAOS_KILL_AFTER_PUBLISH: '3', SQS_CONSUMER_ENABLED: 'false', OUTBOX_POLL_INTERVAL_MS: '60000' }],
    });
  }, 60_000);
  afterAll(async () => destroyEnv(env, later), 60_000);

  it('nenhum evento perdido, nenhuma publicação duplicada entre os 3 publishers vivos', async () => {
    const [chaos] = env.instances;
    // 15 wallets → 30 eventos de abertura confirmados; o publisher desta instância ainda não rodou de novo
    await Promise.all(Array.from({ length: 15 }, () => openWallet(chaos, '10.00')));
    const total = await pendingOutbox(env.db);
    expect(total).toBe(30);

    // Novo ciclo: o publisher envia 3 eventos ao SQS e morre antes do commit (rollback)
    await chaos.stop('SIGKILL');
    const chaos2 = await startInstance(
      'mi_outbox-chaos',
      env.topology,
      { CHAOS_KILL_AFTER_PUBLISH: '3', SQS_CONSUMER_ENABLED: 'false' },
      { waitReady: false }, // publica no bootstrap e morre antes de responder HTTP
    );
    later.push(chaos2);
    expect((await chaos2.exited).signal).toBe('SIGKILL');
    expect(await pendingOutbox(env.db)).toBe(total); // nada marcado como publicado

    // 3 publishers saudáveis assumem
    const healthy = await Promise.all(
      [1, 2, 3].map((i) => startInstance(`mi_outbox-${i}`, env.topology, { SQS_CONSUMER_ENABLED: 'false', OUTBOX_BATCH_SIZE: '4' })),
    );
    later.push(...healthy);
    await waitFor(async () => (await pendingOutbox(env.db)) === 0, 20_000, 200);

    // Entre os vivos, cada evento foi enviado exatamente uma vez (SKIP LOCKED)
    const sentByHealthy = healthy.reduce((s, i) => s + sumLogField(i, 'Outbox events published', 'published'), 0);
    expect(sentByHealthy).toBe(total);

    // Na fila, cada evento aparece uma vez: os 3 republicados pelo morto foram descartados pelo eventId
    const ids = (await env.events.drain()).map((m) => JSON.parse(m.Body!).eventId as string);
    const outboxIds = (await env.db.sql<{ id: string }>(`select id from outbox_messages`)).map((r) => r.id);
    expect(ids.length).toBe(total);
    expect(new Set(ids)).toEqual(new Set(outboxIds));
  }, 90_000);
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Reinício do serviço durante tráfego, com comprovação da consistência final', () => {
  let env: Env;
  const later: AppInstance[] = [];
  beforeAll(async () => {
    env = await createEnv('mi_restart');
  }, 60_000);
  afterAll(async () => destroyEnv(env, later), 90_000);

  it('SIGKILL e SIGTERM no meio do tráfego HTTP + fila; após reiniciar, tudo aplicado exatamente uma vez', async () => {
    const apps = env.instances;
    const wallets = await Promise.all(Array.from({ length: 15 }, (_, i) => openWallet(apps[i % 3])));

    // Por wallet: 4 BETs pela fila e 3 pela API (7 × 2.00)
    const queued = wallets.flatMap((w) => Array.from({ length: 4 }, () => ({ w, body: tx(w, 'BET', '2.00') })));
    const viaHttp = wallets.flatMap((w) => Array.from({ length: 3 }, () => ({ w, body: tx(w, 'BET', '2.00') })));

    for (const { w, body } of queued) await env.queues.send(body, w.id);
    const httpTraffic = Promise.all(viaHttp.map(({ body }, i) => submitWithFailover(apps, i, body)));

    // Falhas no meio do tráfego: uma morte abrupta e um desligamento gracioso
    await sleep(150);
    await apps[0].stop('SIGKILL');
    await sleep(150);
    // SIGTERM com tráfego HTTP em andamento: encerramento gracioso dentro do prazo do Docker (10s)
    const t0 = Date.now();
    const graceful = await apps[1].stop('SIGTERM');
    expect(Date.now() - t0).toBeLessThan(10_000);
    // O Nest reemite o SIGTERM após os hooks; os workers registraram a parada limpa
    expect(graceful.signal).toBe('SIGTERM');
    expect(apps[1].logs()).toContain('SQS consumer stopped');
    expect(apps[1].logs()).toContain('Outbox relay stopped');

    const responses = await httpTraffic;
    expect(responses.every((r) => r.status === 201 || r.status === 200)).toBe(true);

    // Serviço reiniciado
    const restarted = await Promise.all([startInstance('mi_restart-r1', env.topology), startInstance('mi_restart-r2', env.topology)]);
    later.push(...restarted);

    await waitFor(async () => (await queueDrained(env.queues)) && (await pendingOutbox(env.db)) === 0, 45_000, 300);

    for (const w of wallets) {
      expect(await balance(env.db, w.id)).toBe('86.00');
      const rows = await txRows(env.db, w.id);
      expect(rows).toHaveLength(7);
      expect(new Set(rows.map((r) => r.external_transaction_id)).size).toBe(7);
      expect(rows.every((r) => r.status === 'PROCESSED')).toBe(true);
      expect(await ledgerDirections(env.db, w.id)).toHaveLength(7);
    }
    const [{ n }] = await env.db.sql<{ n: number }>(`select count(*)::int as n from inbox_messages`);
    expect(n).toBe(queued.length);
    expect(await env.queues.count(env.queues.dlqUrl)).toEqual({ visible: 0, inFlight: 0 });
  }, 120_000);
});
