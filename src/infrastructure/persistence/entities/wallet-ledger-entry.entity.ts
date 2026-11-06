import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
  Enum,
  ManyToOne,
} from '@mikro-orm/core';
import { WalletEntity } from './wallet.entity';
import { WagerTransactionEntity } from './wager-transaction.entity';
import { LedgerDirection } from '../../../domain/wallet/ledger-direction.enum';

@Entity({ tableName: 'wallet_ledger_entries' })
@Unique({ name: 'uq_ledger_transaction', properties: ['transaction'] })
export class WalletLedgerEntryEntity {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @ManyToOne(() => WalletEntity, { fieldName: 'wallet_id', columnType: 'uuid' })
  wallet!: WalletEntity;

  @ManyToOne(() => WagerTransactionEntity, { fieldName: 'transaction_id', columnType: 'uuid' })
  transaction!: WagerTransactionEntity;

  @Enum({ items: () => LedgerDirection, columnType: 'varchar' })
  direction!: LedgerDirection;

  @Property({ columnType: 'decimal(19,4)' })
  moneyAmount!: string; // nunca number

  @Property({ columnType: 'char(3)' })
  moneyCurrency!: string;

  @Property({ columnType: 'decimal(19,4)' })
  balanceBeforeAmount!: string; // nunca number

  @Property({ columnType: 'decimal(19,4)' })
  balanceAfterAmount!: string; // nunca number

  @Property({ columnType: 'timestamptz', onCreate: () => new Date() })
  createdAt: Date = new Date();
}
