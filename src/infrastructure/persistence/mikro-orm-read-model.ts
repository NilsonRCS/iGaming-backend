import { MikroORM } from '@mikro-orm/core';
import { LedgerPosition, LedgerRow, WageringReadModel } from '../../application/ports/wagering-read-model.port';
import { Money } from '../../shared/money/money';
import { WalletEntity } from './entities/wallet.entity';
import { WagerTransactionEntity } from './entities/wager-transaction.entity';
import { toWagerTransaction, toWallet } from './mappers';

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
    const e = await this.orm.em.fork().findOne(WalletEntity, { id });
    return e ? toWallet(e) : null;
  }

  async findTransaction(id: string) {
    const e = await this.orm.em.fork().findOne(WagerTransactionEntity, { id });
    return e ? toWagerTransaction(e) : null;
  }

  async findTransactionByExternalId(providerId: string, externalTransactionId: string) {
    const e = await this.orm.em.fork().findOne(WagerTransactionEntity, { providerId, externalTransactionId });
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

    const rows: LedgerSqlRow[] = await this.orm.em.fork().getConnection().execute(
      `select id, wallet_id, transaction_id, direction, money_amount, money_currency,
              balance_before_amount, balance_after_amount, created_at, created_at::text as created_at_text
         from wallet_ledger_entries
        where wallet_id = ? ${keyset}
        order by created_at desc, id desc
        limit ?`,
      params as never[],
    );

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
}
