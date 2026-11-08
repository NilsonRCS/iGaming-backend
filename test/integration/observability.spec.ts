import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { randomUUID } from 'crypto';
import { createTestDatabase, TestDatabase } from './support/test-database';
import { walletsOutOfBalance } from './support/fixtures';
import { createTestEventsQueue, createTestQueues, sleep, TestEventsQueue, TestQueues, waitFor } from './support/test-queues';
import { AppInstance, startInstance } from './support/app-instances';
import { openWallet, submit, tx } from './support/api-client';

/**
 * Seção 12 e 9.5 sobre o processo real (`bun src/main.ts`): o que vai para o stdout,
 * o que o /metrics expõe e como o /health/ready reage a PostgreSQL e SQS fora do ar.
 */

let db: TestDatabase;
let queues: TestQueues;
let events: TestEventsQueue;
let app: AppInstance;
const extra: AppInstance[] = [];

beforeAll(async () => {
  db = await createTestDatabase('obs');
  queues = await createTestQueues('obs', { visibilityTimeout: 3 });
  events = await createTestEventsQueue('obs');
  // NODE_ENV=development como no compose: era nele que o debug do ORM vazava valores no log
  app = await startInstance(
    'obs-1',
    { db, queueUrl: queues.queueUrl, dlqUrl: queues.dlqUrl, eventsQueueUrl: events.url },
    { NODE_ENV: 'development' },
  ).catch(
    async (e) => {
      await queues.destroy();
      await events.destroy();
      await db.destroy();
      throw e;
    },
  );
}, 60_000);

afterAll(async () => {
  try {
    if (db) expect(await walletsOutOfBalance(db)).toEqual([]);
  } finally {
    await Promise.all([app, ...extra].filter(Boolean).map((i) => i.stop('SIGKILL')));
    await queues?.destroy();
    await events?.destroy();
    await db?.setAcceptingConnections(true).catch(() => undefined);
    await db?.destroy();
  }
}, 60_000);

/** Todas as linhas do stdout do processo, já parseadas (falha se alguma não for JSON). */
function logLines(instance: AppInstance = app): Record<string, any>[] {
  return instance
    .logs()
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        throw new Error(`log line is not JSON: ${l}`);
      }
    });
}

async function metrics(instance: AppInstance = app): Promise<string> {
  const r = await fetch(`http://127.0.0.1:${instance.port}/metrics`);
  expect(r.status).toBe(200);
  expect(r.headers.get('content-type')).toContain('text/plain');
  return r.text();
}

/** Soma das amostras de `name` cujos labels contêm todos os pares de `labels`. */
function sample(text: string, name: string, labels: Record<string, string> = {}): number {
  return text
    .split('\n')
    .filter((l) => l.startsWith(name + '{') || l.startsWith(name + ' '))
    .filter((l) => Object.entries(labels).every(([k, v]) => l.includes(`${k}="${v}"`)))
    .reduce((s, l) => s + Number(l.slice(l.lastIndexOf(' ') + 1)), 0);
}

async function sendRaw(body: unknown, groupId: string, correlationId?: string): Promise<string> {
  const r = await queues.sqs.send(
    new SendMessageCommand({
      QueueUrl: queues.queueUrl,
      MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      MessageGroupId: groupId,
      MessageDeduplicationId: randomUUID(),
      MessageAttributes: correlationId ? { correlationId: { DataType: 'String', StringValue: correlationId } } : undefined,
    }),
  );
  return r.MessageId!;
}

const drained = async () => {
  const c = await queues.count(queues.queueUrl);
  return c.visible === 0 && c.inFlight === 0;
};

// ─────────────────────────────────────────────────────────────────────────────

describe('Logs estruturados (JSON)', () => {
  it('HTTP: correlationId do header em toda linha da requisição, com transactionId, walletId e providerId; sem valores', async () => {
    const w = await openWallet(app, '123.45', { 'x-correlation-id': 'corr-wallet-1' });
    const bet = tx(w, 'BET', '37.45');
    const r = await submit(app, bet, { 'x-correlation-id': 'corr-bet-1' });
    expect(r.status).toBe(201);

    const res = await fetch(`http://127.0.0.1:${app.port}/wallets/${w.id}`, { headers: { 'x-correlation-id': 'corr-get-1' } });
    expect(res.headers.get('x-correlation-id')).toBe('corr-get-1');
    await sleep(200);

    const lines = logLines();
    const handled = lines.find((l) => l.msg === 'Wager transaction handled' && l.correlationId === 'corr-bet-1');
    expect(handled).toMatchObject({
      level: 'info',
      service: 'igaming-backend',
      source: 'http',
      transactionId: r.body.transaction.id,
      walletId: w.id,
      providerId: 'provider-a',
      kind: 'BET',
      status: 'PROCESSED',
      idempotentReplay: false,
    });
    expect(typeof handled!.durationMs).toBe('number');

    // Entrada/saída da requisição com o mesmo correlationId
    const requestLines = lines.filter((l) => l.correlationId === 'corr-bet-1' && /^HTTP request/.test(l.msg));
    expect(requestLines.map((l) => l.msg)).toEqual(['HTTP request received', 'HTTP request completed']);
    expect(requestLines[1]).toMatchObject({ method: 'POST', route: '/wagering/transactions', statusCode: 201 });

    // Nenhuma linha com chave duplicada (ex.: correlationId do Fastify + do contexto)
    for (const l of app.logs().split('\n').filter((x) => x.includes('corr-bet-1'))) {
      expect(l.split('"correlationId"').length - 1).toBe(1);
    }

    // Nenhum valor monetário (saldo inicial, aposta) nem corpo da requisição nos logs
    const raw = app.logs();
    expect(raw).not.toContain('123.45');
    expect(raw).not.toContain('37.45');
  });

  it('correlationId inseguro no header é substituído por um UUID', async () => {
    const res = await fetch(`http://127.0.0.1:${app.port}/health/live`, { headers: { 'x-correlation-id': 'tem espaço <script>' } });
    expect(res.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('SQS: correlationId do atributo da mensagem (ou o MessageId) + messageId em toda linha da mensagem', async () => {
    const w = await openWallet(app);
    const withAttr = await sendRaw(tx(w, 'BET', '1.00'), w.id, 'corr-sqs-1');
    const withoutAttr = await sendRaw(tx(w, 'BET', '2.00'), w.id);
    await waitFor(drained, 15_000);
    await sleep(200);

    const lines = logLines();
    const a = lines.filter((l) => l.messageId === withAttr);
    expect(a.map((l) => l.msg)).toEqual(expect.arrayContaining(['Wager transaction handled', 'Message processed']));
    expect(a.every((l) => l.correlationId === 'corr-sqs-1')).toBe(true);
    expect(a.find((l) => l.msg === 'Wager transaction handled')).toMatchObject({ source: 'sqs', walletId: w.id, providerId: 'provider-a' });

    const b = lines.filter((l) => l.messageId === withoutAttr);
    expect(b.length).toBeGreaterThan(0);
    expect(b.every((l) => l.correlationId === withoutAttr)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Métricas (/metrics)', () => {
  it('transações por status, duplicatas, conflitos, DLQ, lock, outbox e latência', async () => {
    const w = await openWallet(app, '50.00');
    const bet = tx(w, 'BET', '10.00');
    expect((await submit(app, bet)).status).toBe(201);
    expect((await submit(app, bet)).status).toBe(200); // duplicata
    expect((await submit(app, { ...bet, money: { amount: '11.00', currency: 'BRL' } })).status).toBe(409); // conflito
    expect((await submit(app, tx(w, 'BET', '999.00'))).status).toBe(422); // rejeitada

    // Disputa pelo lock da mesma wallet
    const contended = await openWallet(app, '100.00');
    await Promise.all(Array.from({ length: 10 }, () => submit(app, tx(contended, 'BET', '1.00'))));

    // Fila: uma processada e uma inválida (DLQ)
    await sendRaw(tx(w, 'BET', '1.00'), w.id);
    await sendRaw('{not json', w.id);
    await waitFor(drained, 15_000);
    await waitFor(async () => sample(await metrics(), 'outbox_pending_messages') === 0, 10_000);

    const m = await metrics();
    expect(sample(m, 'wagering_transactions_total', { source: 'http', kind: 'BET', status: 'PROCESSED' })).toBeGreaterThanOrEqual(11);
    expect(sample(m, 'wagering_transactions_total', { source: 'http', kind: 'BET', status: 'REJECTED' })).toBeGreaterThanOrEqual(1);
    expect(sample(m, 'wagering_transactions_total', { source: 'sqs', kind: 'BET', status: 'PROCESSED' })).toBeGreaterThanOrEqual(1);
    expect(sample(m, 'wagering_duplicates_total', { source: 'http' })).toBeGreaterThanOrEqual(1);
    expect(sample(m, 'wagering_idempotency_conflicts_total', { source: 'http' })).toBe(1);
    expect(sample(m, 'sqs_dlq_messages_total', { error_code: 'INVALID_PAYLOAD' })).toBe(1);
    expect(sample(m, 'sqs_dlq_depth')).toBeGreaterThanOrEqual(1);
    expect(sample(m, 'wallet_lock_conflicts_total')).toBeGreaterThan(0);
    expect(sample(m, 'wallet_lock_wait_seconds_count')).toBeGreaterThanOrEqual(12);
    expect(sample(m, 'outbox_lag_seconds')).toBe(0);
    expect(sample(m, 'outbox_publish_delay_seconds_count')).toBeGreaterThan(0);
    expect(sample(m, 'wagering_processing_duration_seconds_count', { source: 'http', outcome: 'PROCESSED' })).toBeGreaterThanOrEqual(11);
    expect(sample(m, 'http_request_duration_seconds_count', { method: 'POST', route: '/wagering/transactions', status_code: '201' })).toBeGreaterThanOrEqual(11);
    expect(m).toContain('# HELP wagering_retries_total');
    expect(m).toContain('process_cpu_seconds_total');
  }, 60_000);
});

describe('Reconciliação (seção 9.4)', () => {
  it('divergência: log warn com identificadores e sem valores, métrica e resposta; nada é corrigido', async () => {
    const w = await openWallet(app, '64.20');
    await db.sql(`update wallets set balance_amount = balance_amount + 0.37 where id = ?`, [w.id]);
    try {
      const r = await app.http('POST', `/wallets/${w.id}/reconciliation`, undefined, { 'x-correlation-id': 'corr-recon-1' });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ consistent: false, difference: { amount: '0.37' } });
      await sleep(200);

      const line = logLines().find((l) => l.msg === 'Wallet balance divergence detected' && l.walletId === w.id);
      expect(line).toMatchObject({ level: 'warn', correlationId: 'corr-recon-1', consistent: false, ledgerEntries: 1 });
      const raw = app.logs().split('\n').filter((l) => l.includes(w.id)).join('\n');
      expect(raw).not.toContain('64.57');
      expect(raw).not.toContain('0.37');
      expect(sample(await metrics(), 'wallet_reconciliations_total', { result: 'divergent' })).toBeGreaterThanOrEqual(1);
    } finally {
      await db.sql(`update wallets set balance_amount = balance_amount - 0.37 where id = ?`, [w.id]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Health checks', () => {
  it('live e ready respondem 200 com PostgreSQL e SQS no ar', async () => {
    expect(await app.http('GET', '/health/live')).toEqual({ status: 200, body: { status: 'ok' } });
    const ready = await app.http('GET', '/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ status: 'ok', info: { postgres: { status: 'up' }, sqs: { status: 'up' } } });
  });

  it('SQS inalcançável: ready 503 com sqs down; live continua 200', async () => {
    const noSqs = await startInstance(
      'obs-nosqs',
      { db, queueUrl: queues.queueUrl, dlqUrl: queues.dlqUrl, eventsQueueUrl: events.url },
      { AWS_ENDPOINT: 'http://127.0.0.1:1' },
    );
    extra.push(noSqs);
    const ready = await noSqs.http('GET', '/health/ready');
    expect(ready.status).toBe(503);
    expect(ready.body.error).toMatchObject({ sqs: { status: 'down' } });
    expect(ready.body.details).toMatchObject({ postgres: { status: 'up' } });
    expect((await noSqs.http('GET', '/health/live')).status).toBe(200);
  }, 30_000);

  it('PostgreSQL recusando conexões: ready 503, API 503, mensagem com retry; tudo volta quando o banco volta', async () => {
    const w = await openWallet(app);
    const before = sample(await metrics(), 'wagering_retries_total', { operation: 'sqs_redelivery' });

    await db.setAcceptingConnections(false);
    try {
      const ready = await app.http('GET', '/health/ready');
      expect(ready.status).toBe(503);
      expect(ready.body.error).toMatchObject({ postgres: { status: 'down' } });
      expect(ready.body.details).toMatchObject({ sqs: { status: 'up' } });
      expect((await app.http('GET', '/health/live')).status).toBe(200);

      // Seção 9.6: falha transitória de infraestrutura → 503 com Retry-After
      const r = await submit(app, tx(w, 'BET', '5.00'));
      expect(r.status).toBe(503);
      expect(r.body.error).toBe('TRANSIENT_INFRASTRUCTURE_ERROR');

      // Mensagem chegando durante a queda: retry com backoff (não DLQ)
      await sendRaw(tx(w, 'BET', '7.00'), w.id);
      await waitFor(async () => sample(await metrics(), 'wagering_retries_total', { operation: 'sqs_redelivery' }) > before, 15_000);
      expect(Number.isNaN(sample(await metrics(), 'outbox_pending_messages'))).toBe(true); // /metrics segue respondendo
    } finally {
      await db.setAcceptingConnections(true);
    }

    await waitFor(async () => (await app.http('GET', '/health/ready')).status === 200, 15_000);
    await waitFor(drained, 20_000);
    const [{ b }] = await db.sql<{ b: string }>(`select balance_amount::numeric(19,2)::text as b from wallets where id = ?`, [w.id]);
    expect(b).toBe('93.00'); // só a mensagem da fila foi aplicada (a requisição HTTP recebeu 503)
    expect(await queues.count(queues.dlqUrl)).toMatchObject({ visible: 1 }); // apenas o JSON inválido do teste anterior
  }, 60_000);
});
