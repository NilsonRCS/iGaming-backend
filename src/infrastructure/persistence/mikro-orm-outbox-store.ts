import { MikroORM } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { OutboxStore } from '../../application/ports/outbox.port';
import { OutboxMessage } from '../../domain/shared/messaging/outbox-message';
import { IntegrationEventEnvelope } from '../../domain/shared/events/integration-event';
import { translateDriverError } from './mikro-orm-unit-of-work';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: IntegrationEventEnvelope;
  occurred_at: string | Date;
  attempts: number;
  next_attempt_at: string | Date | null;
  db_now: string | Date;
}

/**
 * Reivindica eventos devidos com FOR UPDATE SKIP LOCKED: linhas bloqueadas por outro
 * publisher são puladas (sem espera, sem publicação dupla). Um evento cuja wallet tem
 * evento anterior ainda em backoff não é reivindicado, para não ultrapassá-lo.
 * O tempo vem do banco (now()), não do relógio da instância.
 */
const CLAIM_DUE_SQL = `
  select o.id, o.aggregate_id, o.event_type, o.payload, o.occurred_at, o.attempts, o.next_attempt_at,
         now() as db_now
    from outbox_messages o
   where o.published_at is null
     and (o.next_attempt_at is null or o.next_attempt_at <= now())
     and not exists (
           select 1 from outbox_messages e
            where e.aggregate_id = o.aggregate_id
              and e.published_at is null
              and e.next_attempt_at > now()
              and (e.occurred_at, e.id) < (o.occurred_at, o.id))
   order by o.occurred_at, o.id
   limit ?
     for update of o skip locked`;

export class MikroOrmOutboxStore implements OutboxStore {
  constructor(private readonly orm: MikroORM) {}

  async processDue(limit: number, work: (messages: OutboxMessage[], now: Date) => Promise<void>): Promise<number> {
    try {
      return await (this.orm.em.fork() as EntityManager).transactional(async (em) => {
        const rows = await em.execute<OutboxRow[]>(CLAIM_DUE_SQL, [limit]);
        if (rows.length === 0) return 0;

        // SQL cru devolve timestamptz como texto (parser do MikroORM)
        const now = new Date(rows[0].db_now);
        const messages = rows.map(toOutboxMessage);
        const attemptsBefore = new Map(messages.map((m) => [m.id, m.attempts]));

        await work(messages, now);

        await persist(em, messages, attemptsBefore);
        return rows.length;
      });
    } catch (e) {
      throw translateDriverError(e);
    }
  }
}

async function persist(em: EntityManager, messages: OutboxMessage[], attemptsBefore: Map<string, number>): Promise<void> {
  const published = messages.filter((m) => !m.isPending());
  if (published.length > 0) {
    // Mesmo instante (now() da transação) para todo o lote publicado
    const placeholders = published.map(() => '?').join(', ');
    await em.execute(`update outbox_messages set published_at = ? where id in (${placeholders})`, [
      published[0].publishedAt,
      ...published.map((m) => m.id),
    ]);
  }
  for (const m of messages) {
    if (m.isPending() && m.attempts !== attemptsBefore.get(m.id)) {
      await em.execute(`update outbox_messages set attempts = ?, next_attempt_at = ? where id = ?`, [
        m.attempts,
        m.nextAttemptAt,
        m.id,
      ]);
    }
  }
}

function toOutboxMessage(row: OutboxRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload,
    occurredAt: new Date(row.occurred_at),
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at ? new Date(row.next_attempt_at) : undefined,
  });
}
