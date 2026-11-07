import { describe, expect, it } from 'bun:test';
import { Metrics } from './metrics';
import { InstrumentedWagerProcessor, WagerProcessor } from './instrumented-processor';
import { IdempotencyConflictError, InvalidPayloadError } from '../../application/errors';
import { StructuredLogger } from './logger';

const value = async (m: Metrics, name: string, labels: Record<string, string> = {}) => {
  const metric = (await m.registry.getMetricsAsJSON()).find((x) => x.name === name);
  const v = metric?.values.find((x: any) => Object.entries(labels).every(([k, val]) => x.labels[k] === val));
  return v?.value;
};

function logger() {
  const entries: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
  const l: StructuredLogger & { entries: typeof entries } = {
    entries,
    log: (msg, fields) => entries.push({ level: 'info', msg, fields }),
    warn: (msg, fields) => entries.push({ level: 'warn', msg, fields }),
    error: (msg, fields) => entries.push({ level: 'error', msg, fields }),
  };
  return l;
}

const view = (status: string) => ({
  id: 't-1',
  providerId: 'provider-a',
  externalTransactionId: 'ext-1',
  walletId: 'w-1',
  playerId: 'p-1',
  roundId: 'r',
  gameId: 'g',
  kind: 'BET',
  money: { amount: '10.00', currency: 'BRL' },
  referenceExternalTransactionId: null,
  referenceTransactionId: null,
  status,
  failureCode: status === 'REJECTED' ? 'INSUFFICIENT_BALANCE' : null,
  processedAt: null,
  createdAt: '2026-11-07T00:00:00.000Z',
});

const inner = (impl: () => Promise<any>): WagerProcessor => ({ execute: impl });
const cmd = { walletId: 'w-1', providerId: 'provider-a', externalTransactionId: 'ext-1', kind: 'BET', amount: '10.00' } as any;

describe('InstrumentedWagerProcessor', () => {
  it('transação nova: conta por source/kind/status, mede latência e loga só identificadores', async () => {
    const m = new Metrics();
    const log = logger();
    const p = new InstrumentedWagerProcessor(inner(async () => ({ idempotentReplay: false, transaction: view('REJECTED') })), m, log, 'sqs');
    await p.execute(cmd);

    expect(await value(m, 'wagering_transactions_total', { source: 'sqs', kind: 'BET', status: 'REJECTED' })).toBe(1);
    const text = await m.render();
    expect(text).toContain('wagering_processing_duration_seconds_count{source="sqs",outcome="REJECTED"} 1');

    expect(log.entries[0]).toMatchObject({
      level: 'info',
      fields: { source: 'sqs', transactionId: 't-1', walletId: 'w-1', providerId: 'provider-a', status: 'REJECTED', failureCode: 'INSUFFICIENT_BALANCE' },
    });
    expect(JSON.stringify(log.entries)).not.toContain('10.00');
  });

  it('replay conta como duplicata, não como transação nova', async () => {
    const m = new Metrics();
    const p = new InstrumentedWagerProcessor(inner(async () => ({ idempotentReplay: true, transaction: view('PROCESSED') })), m, logger(), 'http');
    await p.execute(cmd);
    await p.execute(cmd);
    expect(await value(m, 'wagering_duplicates_total', { source: 'http' })).toBe(2);
    expect(await value(m, 'wagering_transactions_total', { source: 'http' })).toBeUndefined();
  });

  it('erro: conflito de idempotência é contado; o erro é relançado e logado com o código', async () => {
    const m = new Metrics();
    const log = logger();
    const p = new InstrumentedWagerProcessor(inner(async () => { throw new IdempotencyConflictError('k', 't'); }), m, log, 'http');
    await expect(p.execute(cmd)).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await value(m, 'wagering_idempotency_conflicts_total', { source: 'http' })).toBe(1);
    expect(log.entries[0]).toMatchObject({ level: 'warn', fields: { errorCode: 'PAYLOAD_CONFLICT', walletId: 'w-1' } });

    const q = new InstrumentedWagerProcessor(inner(async () => { throw new InvalidPayloadError(['x']); }), m, log, 'http');
    await expect(q.execute({ walletId: 42 } as any)).rejects.toBeInstanceOf(InvalidPayloadError);
    expect(log.entries[1].fields?.walletId).toBeUndefined(); // campo inválido não vai para o log
    expect(await m.render()).toContain('wagering_processing_duration_seconds_count{source="http",outcome="INVALID_PAYLOAD"} 1');
  });
});

describe('Metrics — gauges lidos no scrape', () => {
  it('usa as fontes registradas', async () => {
    const m = new Metrics();
    m.setOutboxSource(async () => ({ pending: 7, oldestAgeSeconds: 12.5 }));
    m.setDlqDepthSource(async () => 3);
    const text = await m.render();
    expect(text).toContain('outbox_pending_messages 7');
    expect(text).toContain('outbox_lag_seconds 12.5');
    expect(text).toContain('sqs_dlq_depth 3');
  });

  it('fonte indisponível vira NaN e é reportada, sem derrubar o /metrics', async () => {
    const m = new Metrics();
    const errors: string[] = [];
    m.setSourceErrorHandler((metric) => errors.push(metric));
    m.setOutboxSource(async () => { throw new Error('db down'); });
    const text = await m.render();
    expect(text).toContain('outbox_pending_messages Nan');
    expect(text).toContain('sqs_dlq_depth Nan'); // sem fonte
    expect(errors.sort()).toEqual(['outbox_lag_seconds', 'outbox_pending_messages']);
  });

  it('registros independentes por instância (várias apps no mesmo processo)', () => {
    expect(() => [new Metrics(), new Metrics()]).not.toThrow();
  });
});
