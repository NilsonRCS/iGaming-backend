import { OutboxMessage } from '../../domain/shared/messaging/outbox-message';
import { EventPublisher, OutboxStore } from '../ports/outbox.port';

export interface PublishOutboxBatchResult {
  claimed: number;
  published: number;
  failed: number;
  /** Não tentadas porque um evento anterior da mesma wallet falhou neste lote. */
  deferred: number;
  /** Primeiro erro de publicação do lote (para log). */
  firstError?: unknown;
  /** Para cada evento publicado: segundos entre occurredAt e a publicação. */
  publishDelaysSeconds: number[];
}

/**
 * Um ciclo do publisher (seção 11): reivindica eventos devidos e os publica.
 * Por wallet em sequência (ordem de occurredAt); wallets distintas em paralelo.
 * Após a primeira falha de uma wallet, os eventos seguintes dela ficam intactos para o próximo ciclo.
 */
export class PublishOutboxBatchUseCase {
  constructor(
    private readonly store: OutboxStore,
    private readonly publisher: EventPublisher,
  ) {}

  async execute(batchSize: number): Promise<PublishOutboxBatchResult> {
    const result: PublishOutboxBatchResult = { claimed: 0, published: 0, failed: 0, deferred: 0, publishDelaysSeconds: [] };

    result.claimed = await this.store.processDue(batchSize, async (messages, now) => {
      const byAggregate = new Map<string, OutboxMessage[]>();
      for (const m of messages) {
        const list = byAggregate.get(m.aggregateId) ?? [];
        list.push(m);
        byAggregate.set(m.aggregateId, list);
      }

      await Promise.all(
        [...byAggregate.values()].map(async (sequence) => {
          for (let i = 0; i < sequence.length; i++) {
            const message = sequence[i];
            try {
              await this.publisher.publish(message);
              message.markPublished(now);
              result.published++;
              result.publishDelaysSeconds.push(Math.max(0, (now.getTime() - message.occurredAt.getTime()) / 1000));
            } catch (error) {
              message.scheduleRetry(now);
              result.failed++;
              result.firstError ??= error;
              result.deferred += sequence.length - i - 1;
              return;
            }
          }
        }),
      );
    });

    return result;
  }
}
