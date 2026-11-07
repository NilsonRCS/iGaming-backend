import { Migration } from '@mikro-orm/migrations';

/**
 * Seção 7.4: agendamento persistido do reprocessamento de PENDING_REFERENCE.
 * Aditiva: nenhuma coluna existente muda. Mesmo padrão attempts/next_attempt_at do outbox.
 */
export class Migration20261109_PendingReferenceScheduling extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions
        ADD COLUMN reference_attempts        INTEGER     NOT NULL DEFAULT 0,
        ADD COLUMN next_reference_attempt_at TIMESTAMPTZ NULL;
    `);
    this.addSql(`
      CREATE INDEX idx_wager_pending_reference_due
        ON wager_transactions (next_reference_attempt_at)
        WHERE status = 'PENDING_REFERENCE';
    `);
  }

  async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS idx_wager_pending_reference_due;`);
    this.addSql(`
      ALTER TABLE wager_transactions
        DROP COLUMN IF EXISTS next_reference_attempt_at,
        DROP COLUMN IF EXISTS reference_attempts;
    `);
  }
}
