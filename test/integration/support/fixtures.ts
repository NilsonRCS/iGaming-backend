import { randomUUID } from 'crypto';
import { ProcessWagerTransactionCommand } from '../../../src/application/use-cases/process-wager-transaction.use-case';
import { TestDatabase } from './test-database';

export const PROVIDER = 'provider-a';

export async function newWallet(db: TestDatabase, amount = '100.00', currency = 'BRL') {
  return db.openWallet.execute({ playerId: randomUUID(), initialBalance: { amount, currency } });
}

let seq = 0;

/** Comando válido; `externalTransactionId` e `idempotencyKey` únicos por chamada. */
export function command(
  wallet: { id: string; playerId: string },
  kind: string,
  amount: string,
  extra: Partial<ProcessWagerTransactionCommand> = {},
): ProcessWagerTransactionCommand {
  const externalTransactionId = extra.externalTransactionId ?? `ext-${kind}-${++seq}-${randomUUID()}`;
  return {
    providerId: PROVIDER,
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    amount,
    currency: 'BRL',
    ...extra,
    externalTransactionId,
    idempotencyKey: extra.idempotencyKey ?? `${PROVIDER}:${externalTransactionId}`,
  };
}

export async function balanceOf(db: TestDatabase, walletId: string): Promise<string> {
  const [row] = await db.sql<{ b: string }>(`select balance_amount::numeric(19,2)::text as b from wallets where id = ?`, [walletId]);
  return row.b;
}

export async function ledgerOf(db: TestDatabase, walletId: string) {
  return db.sql<{ direction: string; amount: string; transaction_id: string }>(
    `select direction, money_amount::numeric(19,2)::text as amount, transaction_id
       from wallet_ledger_entries where wallet_id = ? order by created_at, id`,
    [walletId],
  );
}

export async function outboxOf(db: TestDatabase, walletId: string) {
  return db.sql<{ event_type: string; payload: { payload: Record<string, unknown> } }>(
    `select event_type, payload from outbox_messages where aggregate_id = ? order by occurred_at`,
    [walletId],
  );
}

/** Wallets cujo saldo materializado diverge da soma do ledger (deve ser sempre vazio). */
export async function walletsOutOfBalance(db: TestDatabase) {
  return db.sql(
    `select w.id, w.balance_amount, coalesce(sum(case l.direction when 'CREDIT' then l.money_amount else -l.money_amount end), 0) as ledger
       from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
      group by w.id
     having w.balance_amount <> coalesce(sum(case l.direction when 'CREDIT' then l.money_amount else -l.money_amount end), 0)`,
  );
}
