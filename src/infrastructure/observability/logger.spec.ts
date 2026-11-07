import { describe, expect, it } from 'bun:test';
import { Writable } from 'stream';
import { componentLogger, createLogger, PinoNestLogger } from './logger';
import { runWithLogContext, sanitizeCorrelationId } from './correlation';

function capture() {
  const lines: Record<string, any>[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      for (const l of String(chunk).split('\n').filter(Boolean)) lines.push(JSON.parse(l));
      cb();
    },
  });
  return { lines, logger: createLogger(stream as never, 'debug') };
}

describe('logger JSON', () => {
  it('uma linha JSON por evento, com level textual, time ISO, service e msg', () => {
    const { lines, logger } = capture();
    componentLogger('Test', logger).log('hello', { walletId: 'w-1' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'info', service: 'igaming-backend', context: 'Test', msg: 'hello', walletId: 'w-1' });
    expect(new Date(lines[0].time).toISOString()).toBe(lines[0].time);
  });

  it('inclui correlationId e messageId do contexto atual em toda linha', async () => {
    const { lines, logger } = capture();
    const log = componentLogger('Test', logger);
    await runWithLogContext({ correlationId: 'corr-1', messageId: 'msg-1' }, async () => {
      await Promise.resolve();
      log.log('inside');
    });
    log.log('outside');
    expect(lines[0]).toMatchObject({ correlationId: 'corr-1', messageId: 'msg-1', msg: 'inside' });
    expect(lines[1].correlationId).toBeUndefined();
  });

  it('redige valores, saldos, payloads e corpos mesmo se logados por engano', () => {
    const { lines, logger } = capture();
    componentLogger('Test', logger).log('oops', {
      amount: '10.00',
      money: { amount: '10.00', currency: 'BRL' },
      balance: '90.00',
      payload: { x: 1 },
      body: '{"amount":"10.00"}',
      tx: { amount: '5.00', money: {}, id: 't-1' },
      walletId: 'w-1',
    });
    const l = lines[0];
    for (const k of ['amount', 'money', 'balance', 'payload', 'body']) expect(l[k]).toBe('[REDACTED]');
    expect(l.tx).toEqual({ amount: '[REDACTED]', money: '[REDACTED]', id: 't-1' });
    expect(l.walletId).toBe('w-1');
    expect(JSON.stringify(l)).not.toContain('10.00');
  });

  it('adaptador do Nest: contexto vira campo, erros levam stack', () => {
    const { lines, logger } = capture();
    const nest = new PinoNestLogger(logger);
    nest.log('started', 'NestApplication');
    nest.error('failed', 'Error: boom\n    at x', 'ExceptionHandler');
    nest.warn({ a: 1 }, 'Ctx');
    expect(lines[0]).toMatchObject({ level: 'info', msg: 'started', context: 'NestApplication' });
    expect(lines[1]).toMatchObject({ level: 'error', msg: 'failed', context: 'ExceptionHandler', stack: 'Error: boom\n    at x' });
    expect(lines[2]).toMatchObject({ level: 'warn', a: 1, context: 'Ctx' });
  });
});

describe('sanitizeCorrelationId', () => {
  it.each([['abc-123'], ['provider-a:tx.1_2'], ['a'.repeat(128)]])('aceita %p', (v) => {
    expect(sanitizeCorrelationId(v)).toBe(v);
  });

  it.each([[''], ['com espaço'], ['quebra\nde linha'], ['a'.repeat(129)], ['<script>'], [undefined], [42]])('rejeita %p', (v) => {
    expect(sanitizeCorrelationId(v)).toBeUndefined();
  });

  it('header repetido: usa o primeiro valor', () => {
    expect(sanitizeCorrelationId(['first', 'second'])).toBe('first');
  });
});
