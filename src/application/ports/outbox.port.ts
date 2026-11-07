import { OutboxMessage } from '../../domain/shared/messaging/outbox-message';

/**
 * Acesso do publisher ao outbox. `processDue` abre uma transação, reivindica até `limit`
 * mensagens devidas com `FOR UPDATE SKIP LOCKED`, entrega-as a `work`, persiste o estado
 * final de cada uma (publicada / retry agendado / intacta) e confirma. Se `work` lançar,
 * nada é persistido e os locks são liberados no rollback.
 */
export interface OutboxStore {
  processDue(limit: number, work: (messages: OutboxMessage[], now: Date) => Promise<void>): Promise<number>;
}

/** Publica um evento do outbox no broker. Lança em caso de falha. */
export interface EventPublisher {
  publish(message: OutboxMessage): Promise<void>;
}

export const OUTBOX_STORE = Symbol('OUTBOX_STORE');
export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');
