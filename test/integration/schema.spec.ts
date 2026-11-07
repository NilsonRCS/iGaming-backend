import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createTestDatabase, TestDatabase } from './support/test-database';
import { command, newWallet } from './support/fixtures';

/** Garantias que o schema impõe sozinho, mesmo se a aplicação errar. */
let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase('schema');
});

afterAll(async () => {
  await db?.destroy();
});

describe('Constraints do banco', () => {
  it('saldo negativo é rejeitado pelo CHECK', async () => {
    const w = await newWallet(db);
    await expect(db.sql(`update wallets set balance_amount = -0.01 where id = ?`, [w.id])).rejects.toThrow(
      /chk_balance_non_negative/,
    );
  });

  it('wallet única por (player_id, currency)', async () => {
    const w = await newWallet(db);
    await expect(
      db.sql(
        `insert into wallets (player_id, currency, balance_amount, balance_currency) values (?, 'BRL', 0, 'BRL')`,
        [w.playerId],
      ),
    ).rejects.toThrow(/uq_wallets_player_currency/);
  });

  it('ledger: no máximo um lançamento por transação', async () => {
    const w = await newWallet(db);
    const [{ transaction_id }] = await db.sql<{ transaction_id: string }>(
      `select transaction_id from wallet_ledger_entries where wallet_id = ?`,
      [w.id],
    );
    await expect(
      db.sql(
        `insert into wallet_ledger_entries (wallet_id, transaction_id, direction, money_amount, money_currency, balance_before_amount, balance_after_amount)
         values (?, ?, 'CREDIT', 1, 'BRL', 100, 101)`,
        [w.id, transaction_id],
      ),
    ).rejects.toThrow(/uq_ledger_transaction/);
  });

  it('ledger é append-only: UPDATE, DELETE e TRUNCATE são bloqueados', async () => {
    const w = await newWallet(db);
    await expect(db.sql(`update wallet_ledger_entries set money_amount = 0 where wallet_id = ?`, [w.id])).rejects.toThrow(/append-only/);
    await expect(db.sql(`delete from wallet_ledger_entries where wallet_id = ?`, [w.id])).rejects.toThrow(/append-only/);
    await expect(db.sql(`truncate wallet_ledger_entries cascade`)).rejects.toThrow(/append-only/);
  });

  it('transação única por idempotency_key e por (provider_id, external_transaction_id)', async () => {
    const w = await newWallet(db);
    const cmd = command(w, 'BET', '1.00');
    await db.processTransaction.execute(cmd);

    const insert = (key: string, ext: string) =>
      db.sql(
        `insert into wager_transactions (provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, money_amount, money_currency, status)
         values (?, ?, ?, 'h', ?, ?, 'r', 'g', 'BET', 1, 'BRL', 'PENDING')`,
        [cmd.providerId, ext, key, w.id, w.playerId],
      );

    await expect(insert(cmd.idempotencyKey, 'outro-ext')).rejects.toThrow(/uq_wager_idempotency/);
    await expect(insert('outra-chave', cmd.externalTransactionId)).rejects.toThrow(/uq_wager_provider_ext/);
  });

  it('kind, status e direction só aceitam valores dos ENUMs', async () => {
    const w = await newWallet(db);
    await expect(
      db.sql(
        `insert into wager_transactions (provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, money_amount, money_currency, status)
         values ('p', 'e', 'k', 'h', ?, ?, 'r', 'g', 'JACKPOT', 1, 'BRL', 'PENDING')`,
        [w.id, w.playerId],
      ),
    ).rejects.toThrow(/wager_kind/);
  });
});
