import { describe, it, expect } from 'bun:test';
import { OutboxMessage, OUTBOX_RETRY_BASE_MS, OUTBOX_RETRY_MAX_MS } from './outbox-message';
import { IntegrationEvent } from '../events/integration-event';
import { DomainError } from '../../../shared/errors/domain.error';

class SampleEvent extends IntegrationEvent<{ n: number }> {
  readonly eventType = 'SampleEvent';
  readonly version = 3;
  static make(occurredAt = new Date('2026-01-01T00:00:00Z')) {
    return new SampleEvent('agg-1', { n: 1 }, occurredAt);
  }
}

describe('OutboxMessage', () => {
  it('enqueue() usa o eventId como id e guarda o envelope serializado', () => {
    const ev = SampleEvent.make();
    const m = OutboxMessage.enqueue(ev);
    expect(m.id).toBe(ev.eventId);
    expect(m.aggregateId).toBe('agg-1');
    expect(m.eventType).toBe('SampleEvent');
    expect(m.attempts).toBe(0);
    expect(m.payload).toEqual({
      eventId: ev.eventId,
      eventType: 'SampleEvent',
      version: 3,
      aggregateId: 'agg-1',
      occurredAt: '2026-01-01T00:00:00.000Z',
      payload: { n: 1 },
    });
  });

  it('nasce pendente e devida imediatamente', () => {
    const m = OutboxMessage.enqueue(SampleEvent.make());
    expect(m.isPending()).toBe(true);
    expect(m.isDue(new Date())).toBe(true);
  });

  it('markPublished() encerra a mensagem; publicar de novo é erro', () => {
    const m = OutboxMessage.enqueue(SampleEvent.make());
    const at = new Date();
    m.markPublished(at);
    expect(m.isPending()).toBe(false);
    expect(m.isDue(new Date())).toBe(false);
    expect(m.publishedAt).toBe(at);
    expect(() => m.markPublished(new Date())).toThrow(DomainError);
  });

  it('scheduleRetry() aplica backoff exponencial', () => {
    const m = OutboxMessage.enqueue(SampleEvent.make());
    const now = new Date('2026-01-01T00:00:00Z');

    m.scheduleRetry(now);
    expect(m.attempts).toBe(1);
    expect(m.nextAttemptAt!.getTime() - now.getTime()).toBe(OUTBOX_RETRY_BASE_MS);
    expect(m.isDue(now)).toBe(false);
    expect(m.isDue(new Date(now.getTime() + OUTBOX_RETRY_BASE_MS))).toBe(true);

    m.scheduleRetry(now);
    expect(m.nextAttemptAt!.getTime() - now.getTime()).toBe(OUTBOX_RETRY_BASE_MS * 2);

    m.scheduleRetry(now);
    expect(m.nextAttemptAt!.getTime() - now.getTime()).toBe(OUTBOX_RETRY_BASE_MS * 4);
  });

  it('scheduleRetry() respeita o teto de atraso', () => {
    const m = OutboxMessage.enqueue(SampleEvent.make());
    const now = new Date();
    for (let i = 0; i < 30; i++) m.scheduleRetry(now);
    expect(m.nextAttemptAt!.getTime() - now.getTime()).toBe(OUTBOX_RETRY_MAX_MS);
  });

  it('scheduleRetry() após publicada é erro', () => {
    const m = OutboxMessage.enqueue(SampleEvent.make());
    m.markPublished(new Date());
    expect(() => m.scheduleRetry(new Date())).toThrow(DomainError);
  });
});
