import { MikroORM } from '@mikro-orm/core';
import {
  LedgerPosition,
  LedgerRow,
  ReconciliationSnapshot,
  WageringReadModel,
} from '../../application/ports/wagering-read-model.port';
import { Money } from '../../shared/money/money';
import { WalletEntity } from './entities/wallet.entity';
import { WagerTransactionEntity } from './entities/wager-transaction.entity';
import { toWagerTransaction, toWallet } from './mappers';
import { translateDriverError } from './driver-errors';

/** Banco indisponível nas consultas também vira falha transitória (HTTP 503), não 500. */
async function translated<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw translateDriverError(e);
  }
}

interface LedgerSqlRow {
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: string;
  money_amount: string;
  money_currency: string;
  balance_before_amount: string;
  balance_after_amount: string;
  created_at: Date;
  created_at_text: string;
}

const money = (amount: string, currency: string) => Money.from(amount, currency.trim()).toJSON();

export class MikroOrmReadModel implements WageringReadModel {
  constructor(private readonly orm: MikroORM) {}

  async findWallet(id: string) {
    const e = await translated(() => this.orm.em.fork().findOne(WalletEntity, { id }));
    return e ? toWallet(e) : null;
  }

  async findTransaction(id: string) {
    const e = await translated(() => this.orm.em.fork().findOne(WagerTransactionEntity, { id }));
    return e ? toWagerTransaction(e) : null;
  }

  async findTransactionByExternalId(providerId: string, externalTransactionId: string) {
    const e = await translated(() => this.orm.em.fork().findOne(WagerTransactionEntity, { providerId, externalTransactionId }));
    return e ? toWagerTransaction(e) : null;
  }

  /**
   * Keyset pagination: (created_at, id) < (cursor) na ordem DESC.
   * created_at::text preserva os microssegundos, então o cursor reposiciona exatamente.
   */
  async listLedger(walletId: string, after: LedgerPosition | null, limit: number): Promise<LedgerRow[]> {
    const params: unknown[] = [walletId];
    let keyset = '';
    if (after) {
      keyset = 'and (created_at, id) < (?::timestamptz, ?::uuid)';
      params.push(after.createdAt, after.id);
    }
    params.push(limit);

    const rows: LedgerSqlRow[] = await translated(() => this.orm.em.fork().getConnection().execute(
      `select id, wallet_id, transaction_id, direction, money_amount, money_currency,
              balance_before_amount, balance_after_amount, created_at, created_at::text as created_at_text
         from wallet_ledger_entries
        where wallet_id = ? ${keyset}
        order by created_at desc, id desc
        limit ?`,
      params as never[],
    ));

    return rows.map((r) => ({
      entry: {
        id: r.id,
        walletId: r.wallet_id,
        transactionId: r.transaction_id,
        direction: r.direction,
        money: money(r.money_amount, r.money_currency),
        balanceBefore: money(r.balance_before_amount, r.money_currency),
        balanceAfter: money(r.balance_after_amount, r.money_currency),
        createdAt: new Date(r.created_at).toISOString(),
      },
      position: { createdAt: r.created_at_text, id: r.id },
    }));
  }

  /**
   * Instrução única: o PostgreSQL avalia saldo e soma do ledger no mesmo snapshot, e saldo +
   * lançamento são confirmados no mesmo commit — reconciliação concorrente não acusa divergência falsa.
   */
  async reconciliationSnapshot(walletId: string): Promise<ReconciliationSnapshot | null> {
    const rows: {
      id: string;
      currency: string;
      version: number;
      stored: string;
      ledger: string;
      entries: number;
      checked_at: string | Date;
    }[] = await translated(() =>
      this.orm.em.fork().getConnection().execute(
        `select w.id, w.currency, w.version,
                w.balance_amount::text as stored,
                coalesce(sum(case l.direction when 'CREDIT' then l.money_amount else -l.money_amount end), 0)::text as ledger,
                count(l.id)::int as entries,
                now() as checked_at
           from wallets w
           left join wallet_ledger_entries l on l.wallet_id = w.id
          where w.id = ?
          group by w.id`,
        [walletId],
      ),
    );
    const r = rows[0];
    if (!r) return null;
    return {
      walletId: r.id,
      currency: r.currency.trim(),
      storedBalance: r.stored,
      ledgerBalance: r.ledger,
      ledgerEntries: Number(r.entries),
      walletVersion: Number(r.version),
      checkedAt: new Date(r.checked_at),
    };
  }
}
