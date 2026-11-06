import { Migration } from '@mikro-orm/migrations';

export class Migration20261106_InitialSchema extends Migration {
  async up(): Promise<void> {
    // ── ENUMs ──────────────────────────────────────────────────────────────────
    this.addSql(`
      CREATE TYPE wager_kind AS ENUM (
        'OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'
      );
    `);

    this.addSql(`
      CREATE TYPE wager_status AS ENUM (
        'PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'
      );
    `);

    this.addSql(`
      CREATE TYPE ledger_direction AS ENUM ('DEBIT', 'CREDIT');
    `);

    // ── wallets ────────────────────────────────────────────────────────────────
    this.addSql(`
      CREATE TABLE wallets (
        id                UUID        NOT NULL DEFAULT gen_random_uuid(),
        player_id         UUID        NOT NULL,
        currency          CHAR(3)     NOT NULL,
        balance_amount    DECIMAL(19,4) NOT NULL CONSTRAINT chk_balance_non_negative CHECK (balance_amount >= 0),
        balance_currency  CHAR(3)     NOT NULL,
        version           INTEGER     NOT NULL DEFAULT 1,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

        CONSTRAINT pk_wallets PRIMARY KEY (id),
        CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency)
      );
    `);

    // ── wager_transactions ─────────────────────────────────────────────────────
    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                UUID        NOT NULL DEFAULT gen_random_uuid(),
        provider_id                       VARCHAR     NOT NULL,
        external_transaction_id           VARCHAR     NOT NULL,
        idempotency_key                   VARCHAR     NOT NULL,
        payload_hash                      VARCHAR     NOT NULL,
        wallet_id                         UUID        NOT NULL,
        player_id                         UUID        NOT NULL,
        round_id                          VARCHAR     NOT NULL,
        game_id                           VARCHAR     NOT NULL,
        kind                              VARCHAR     NOT NULL,
        money_amount                      DECIMAL(19,4) NOT NULL,
        money_currency                    CHAR(3)     NOT NULL,
        reference_external_transaction_id VARCHAR,
        reference_transaction_id          UUID,
        status                            VARCHAR     NOT NULL,
        failure_code                      VARCHAR,
        processed_at                      TIMESTAMPTZ,
        created_at                        TIMESTAMPTZ NOT NULL DEFAULT now(),

        CONSTRAINT pk_wager_transactions PRIMARY KEY (id),
        CONSTRAINT uq_wager_provider_ext UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT uq_wager_idempotency  UNIQUE (idempotency_key),
        CONSTRAINT fk_wager_wallet       FOREIGN KEY (wallet_id) REFERENCES wallets (id),
        CONSTRAINT fk_wager_reference    FOREIGN KEY (reference_transaction_id) REFERENCES wager_transactions (id)
      );
    `);

    // ── wallet_ledger_entries ──────────────────────────────────────────────────
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id                    UUID          NOT NULL DEFAULT gen_random_uuid(),
        wallet_id             UUID          NOT NULL,
        transaction_id        UUID          NOT NULL,
        direction             VARCHAR       NOT NULL,
        money_amount          DECIMAL(19,4) NOT NULL,
        money_currency        CHAR(3)       NOT NULL,
        balance_before_amount DECIMAL(19,4) NOT NULL,
        balance_after_amount  DECIMAL(19,4) NOT NULL,
        created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),

        CONSTRAINT pk_ledger_entries       PRIMARY KEY (id),
        CONSTRAINT uq_ledger_transaction   UNIQUE (transaction_id),
        CONSTRAINT fk_ledger_wallet        FOREIGN KEY (wallet_id)       REFERENCES wallets (id),
        CONSTRAINT fk_ledger_transaction   FOREIGN KEY (transaction_id)  REFERENCES wager_transactions (id)
      );
    `);

    // ── inbox_messages ─────────────────────────────────────────────────────────
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name VARCHAR     NOT NULL,
        message_id    VARCHAR     NOT NULL,
        payload_hash  VARCHAR     NOT NULL,
        received_at   TIMESTAMPTZ NOT NULL,
        processed_at  TIMESTAMPTZ,

        CONSTRAINT pk_inbox PRIMARY KEY (consumer_name, message_id)
      );
    `);

    // ── outbox_messages ────────────────────────────────────────────────────────
    this.addSql(`
      CREATE TABLE outbox_messages (
        id              UUID        NOT NULL DEFAULT gen_random_uuid(),
        aggregate_id    VARCHAR     NOT NULL,
        event_type      VARCHAR     NOT NULL,
        payload         JSONB       NOT NULL,
        occurred_at     TIMESTAMPTZ NOT NULL,
        attempts        INTEGER     NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ,
        published_at    TIMESTAMPTZ,

        CONSTRAINT pk_outbox PRIMARY KEY (id)
      );
    `);

    // ── Índices de performance ─────────────────────────────────────────────────
    this.addSql(`
      CREATE INDEX idx_wager_wallet_status
        ON wager_transactions (wallet_id, status);
    `);

    this.addSql(`
      CREATE INDEX idx_wager_provider_ext
        ON wager_transactions (provider_id, external_transaction_id);
    `);

    this.addSql(`
      CREATE INDEX idx_ledger_wallet_created
        ON wallet_ledger_entries (wallet_id, created_at DESC);
    `);

    this.addSql(`
      CREATE INDEX idx_outbox_pending
        ON outbox_messages (published_at, next_attempt_at)
        WHERE published_at IS NULL;
    `);
  }

  async down(): Promise<void> {
    // Ordem inversa respeitando FKs
    this.addSql(`DROP TABLE IF EXISTS outbox_messages CASCADE;`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages CASCADE;`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries CASCADE;`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions CASCADE;`);
    this.addSql(`DROP TABLE IF EXISTS wallets CASCADE;`);

    this.addSql(`DROP TYPE IF EXISTS ledger_direction;`);
    this.addSql(`DROP TYPE IF EXISTS wager_status;`);
    this.addSql(`DROP TYPE IF EXISTS wager_kind;`);
  }
}
