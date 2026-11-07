import { Migration } from '@mikro-orm/migrations';

/**
 * Imutabilidade do ledger garantida no schema (não só em código).
 *
 * wallet_ledger_entries é append-only: o banco aceita apenas INSERT.
 * UPDATE, DELETE e TRUNCATE são rejeitados por triggers, independentemente
 * de qual aplicação, instância ou usuário execute o comando.
 */
export class Migration20261107_LedgerImmutability extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE OR REPLACE FUNCTION fn_ledger_entries_append_only()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only: % is not allowed', TG_OP
          USING ERRCODE = 'integrity_constraint_violation';
      END;
      $$;
    `);

    // Bloqueia sobrescrita e exclusão linha a linha
    this.addSql(`
      CREATE TRIGGER trg_ledger_entries_no_update_delete
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW
        EXECUTE FUNCTION fn_ledger_entries_append_only();
    `);

    // TRUNCATE não dispara triggers de linha; precisa de trigger de statement
    this.addSql(`
      CREATE TRIGGER trg_ledger_entries_no_truncate
        BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT
        EXECUTE FUNCTION fn_ledger_entries_append_only();
    `);
  }

  async down(): Promise<void> {
    this.addSql(`DROP TRIGGER IF EXISTS trg_ledger_entries_no_truncate ON wallet_ledger_entries;`);
    this.addSql(`DROP TRIGGER IF EXISTS trg_ledger_entries_no_update_delete ON wallet_ledger_entries;`);
    this.addSql(`DROP FUNCTION IF EXISTS fn_ledger_entries_append_only();`);
  }
}
