import { describe, expect, it } from 'bun:test';
import { withKillAfterCommit, withKillAfterPublish } from './fault-injection';
import { WagerTransactionProcessor } from './sqs-wager-consumer';
import { EventPublisher } from '../../application/ports/outbox.port';
import { OutboxMessage } from '../../domain/shared/messaging/outbox-message';

const processor: WagerTransactionProcessor = { execute: async () => ({ idempotentReplay: false }) as never };
const publisher: EventPublisher = { publish: async () => undefined };
const message = {} as OutboxMessage;

describe('fault injection', () => {
  it('sem a variável de ambiente devolve o próprio objeto (nada muda em produção)', () => {
    expect(withKillAfterCommit(processor, {})).toBe(processor);
    expect(withKillAfterPublish(publisher, {})).toBe(publisher);
    expect(withKillAfterCommit(processor, { CHAOS_KILL_AFTER_COMMIT: '0' })).toBe(processor);
    expect(withKillAfterCommit(processor, { CHAOS_KILL_AFTER_COMMIT: 'x' })).toBe(processor);
  });

  it('CHAOS_KILL_AFTER_COMMIT=n mata depois do n-ésimo commit (a execução terminou antes)', async () => {
    const order: string[] = [];
    const p = withKillAfterCommit(
      { execute: async () => (order.push('commit'), { idempotentReplay: false }) as never },
      { CHAOS_KILL_AFTER_COMMIT: '2' },
      () => order.push('kill'),
    );
    await p.execute({} as never);
    await p.execute({} as never);
    await p.execute({} as never);
    expect(order).toEqual(['commit', 'commit', 'kill', 'commit']);
  });

  it('CHAOS_KILL_AFTER_PUBLISH=n mata depois do n-ésimo envio e não antes dele', async () => {
    const order: string[] = [];
    const p = withKillAfterPublish(
      { publish: async () => void order.push('publish') },
      { CHAOS_KILL_AFTER_PUBLISH: '1' },
      () => order.push('kill'),
    );
    await p.publish(message);
    await p.publish(message);
    expect(order).toEqual(['publish', 'kill', 'publish']);
  });
});
