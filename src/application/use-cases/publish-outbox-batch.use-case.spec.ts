import { describe, expect, it } from 'bun:test';
import { OutboxMessage } from '../../domain/shared/messaging/outbox-message';
import { EventPublisher, OutboxStore } from '../ports/outbox.port';
import { PublishOutboxBatchUseCase } from './publish-outbox-batch.use-case';

const NOW = new Date('2026-11-07T12:00:00.000Z');

function message(id: string, aggregateId: string, attempts = 0): OutboxMessage {
  return OutboxMessage.rehydrate({
    id,
    aggregateId,
    eventType: 'WagerTransactionProcessed',
    payload: { eventId: id, eventType: 'WagerTransactionProcessed', version: 1, aggregateId, occurredAt: NOW.toISOString(), payload: {} },
    occurredAt: NOW,
    attempts,
  });
}

/** Store em memória: entrega o lote e guarda o que o caso de uso fez com ele. */
function store(messages: OutboxMessage[]): OutboxStore {
  return {
    async processDue(limit, work) {
      const batch = messages.slice(0, limit);
      if (batch.length) await work(batch, NOW);
      return batch.length;
    },
  };
}

function publisher(failFor: Set<string> = new Set()) {
  const sent: string[] = [];
  const p: EventPublisher & { sent: string[] } = {
    sent,
    async publish(m) {
      sent.push(m.id);
      if (failFor.has(m.id)) throw new Error(`broker down for ${m.id}`);
    },
  };
  return p;
}

describe('PublishOutboxBatchUseCase', () => {
  it('publica o lote e marca cada mensagem com o instante da transação', async () => {
    const msgs = [message('a1', 'A'), message('b1', 'B')];
    const pub = publisher();
    const r = await new PublishOutboxBatchUseCase(store(msgs), pub).execute(10);

    expect(r).toEqual({ claimed: 2, published: 2, failed: 0, deferred: 0, publishDelaysSeconds: [0, 0] });
    expect(msgs.every((m) => m.publishedAt?.getTime() === NOW.getTime())).toBe(true);
  });

  it('respeita o tamanho do lote', async () => {
    const msgs = [message('a1', 'A'), message('a2', 'A'), message('a3', 'A')];
    const r = await new PublishOutboxBatchUseCase(store(msgs), publisher()).execute(2);
    expect(r.claimed).toBe(2);
    expect(msgs[2].isPending()).toBe(true);
  });

  it('publica os eventos de uma wallet na ordem do lote', async () => {
    const msgs = [message('a1', 'A'), message('b1', 'B'), message('a2', 'A'), message('a3', 'A')];
    const pub = publisher();
    await new PublishOutboxBatchUseCase(store(msgs), pub).execute(10);
    expect(pub.sent.filter((id) => id.startsWith('a'))).toEqual(['a1', 'a2', 'a3']);
  });

  it('falha agenda retry com backoff; os eventos seguintes da mesma wallet ficam intactos; outras wallets seguem', async () => {
    const msgs = [message('a1', 'A'), message('a2', 'A'), message('a3', 'A'), message('b1', 'B')];
    const pub = publisher(new Set(['a2']));
    const r = await new PublishOutboxBatchUseCase(store(msgs), pub).execute(10);

    expect(r).toMatchObject({ claimed: 4, published: 2, failed: 1, deferred: 1 });
    expect((r.firstError as Error).message).toBe('broker down for a2');
    expect(pub.sent).not.toContain('a3');

    const [a1, a2, a3, b1] = msgs;
    expect(a1.isPending()).toBe(false);
    expect(b1.isPending()).toBe(false);
    expect(a2.isPending()).toBe(true);
    expect(a2.attempts).toBe(1);
    expect(a2.nextAttemptAt?.getTime()).toBe(NOW.getTime() + 1_000);
    expect(a3.isPending()).toBe(true);
    expect(a3.attempts).toBe(0);
    expect(a3.nextAttemptAt).toBeUndefined();
  });

  it('o backoff cresce com as tentativas anteriores', async () => {
    const msgs = [message('a1', 'A', 3)];
    await new PublishOutboxBatchUseCase(store(msgs), publisher(new Set(['a1']))).execute(10);
    expect(msgs[0].attempts).toBe(4);
    expect(msgs[0].nextAttemptAt?.getTime()).toBe(NOW.getTime() + 8_000);
  });

  it('lote vazio não chama o publisher', async () => {
    const pub = publisher();
    expect(await new PublishOutboxBatchUseCase(store([]), pub).execute(10)).toEqual({
      claimed: 0,
      published: 0,
      failed: 0,
      deferred: 0,
      publishDelaysSeconds: [],
    });
    expect(pub.sent).toEqual([]);
  });
});
