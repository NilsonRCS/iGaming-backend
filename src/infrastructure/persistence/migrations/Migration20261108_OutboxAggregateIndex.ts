import { Migration } from '@mikro-orm/migrations';

/**
 * Publisher do outbox: o NOT EXISTS que impede ultrapassar um evento anterior da
 * mesma wallet em backoff busca pendentes por (aggregate_id, occurred_at, id).
 */
export class Migration20261108_OutboxAggregateIndex extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE INDEX idx_outbox_pending_aggregate
        ON outbox_messages (aggregate_id, occurred_at, id)
        WHERE published_at IS NULL;
    `);
  }

  async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS idx_outbox_pending_aggregate;`);
  }
}
