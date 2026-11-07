import { randomUUID } from 'crypto';

export type EventPayload = Record<string, unknown>;

export interface IntegrationEventEnvelope {
  eventId: string;
  eventType: string;
  version: number;
  aggregateId: string;
  occurredAt: string;
  payload: EventPayload;
}

/**
 * Evento publicado para fora do serviço (via outbox).
 * `eventId` é estável: consumidores deduplicam publicações repetidas por ele.
 */
export abstract class IntegrationEvent<P extends EventPayload = EventPayload> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly occurredAt: Date;

  protected constructor(
    readonly aggregateId: string,
    readonly payload: P,
    occurredAt: Date = new Date(),
    eventId: string = randomUUID(),
  ) {
    this.eventId = eventId;
    this.occurredAt = occurredAt;
  }

  toJSON(): IntegrationEventEnvelope {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      version: this.version,
      aggregateId: this.aggregateId,
      occurredAt: this.occurredAt.toISOString(),
      payload: this.payload,
    };
  }
}
