import { DomainError } from '../../../shared/errors/domain.error';
import { IntegrationEvent, IntegrationEventEnvelope } from '../events/integration-event';

export interface OutboxMessageProps {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: IntegrationEventEnvelope;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

/** Backoff exponencial de publicação: 1s, 2s, 4s, ... limitado a 5 minutos. */
export const OUTBOX_RETRY_BASE_MS = 1_000;
export const OUTBOX_RETRY_MAX_MS = 5 * 60_000;

export class OutboxMessage {
  private constructor(private readonly props: OutboxMessageProps) {}

  /** Enfileira o evento; o id da mensagem é o eventId (chave de dedup do consumidor). */
  static enqueue(event: IntegrationEvent): OutboxMessage {
    return new OutboxMessage({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.toJSON(),
      occurredAt: event.occurredAt,
      attempts: 0,
    });
  }

  static rehydrate(props: OutboxMessageProps): OutboxMessage {
    return new OutboxMessage({ ...props });
  }

  isPending(): boolean {
    return this.props.publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    if (!this.isPending()) return false;
    return this.props.nextAttemptAt === undefined || this.props.nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new DomainError(`Outbox message ${this.props.id} is already published`);
    }
    this.props.publishedAt = at;
  }

  scheduleRetry(now: Date): void {
    if (!this.isPending()) {
      throw new DomainError(`Outbox message ${this.props.id} is already published`);
    }
    this.props.attempts += 1;
    const delay = Math.min(OUTBOX_RETRY_BASE_MS * 2 ** (this.props.attempts - 1), OUTBOX_RETRY_MAX_MS);
    this.props.nextAttemptAt = new Date(now.getTime() + delay);
  }

  get id(): string { return this.props.id; }
  get aggregateId(): string { return this.props.aggregateId; }
  get eventType(): string { return this.props.eventType; }
  get payload(): IntegrationEventEnvelope { return this.props.payload; }
  get occurredAt(): Date { return this.props.occurredAt; }
  get attempts(): number { return this.props.attempts; }
  get nextAttemptAt(): Date | undefined { return this.props.nextAttemptAt; }
  get publishedAt(): Date | undefined { return this.props.publishedAt; }
}
