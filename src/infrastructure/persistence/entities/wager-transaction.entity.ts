import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
  Enum,
  ManyToOne,
} from '@mikro-orm/core';
import { WalletEntity } from './wallet.entity';
import { WagerKind, WagerStatus } from '../../../domain/wager-transaction/wager-transaction.enums';

@Entity({ tableName: 'wager_transactions' })
@Unique({ name: 'uq_wager_provider_ext', properties: ['providerId', 'externalTransactionId'] })
@Unique({ name: 'uq_wager_idempotency', properties: ['idempotencyKey'] })
export class WagerTransactionEntity {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @Property({ columnType: 'varchar' })
  providerId!: string;

  @Property({ columnType: 'varchar' })
  externalTransactionId!: string;

  @Property({ columnType: 'varchar' })
  idempotencyKey!: string;

  @Property({ columnType: 'varchar' })
  payloadHash!: string;

  @ManyToOne(() => WalletEntity, { fieldName: 'wallet_id', columnType: 'uuid' })
  wallet!: WalletEntity;

  @Property({ type: 'uuid', columnType: 'uuid' })
  playerId!: string;

  @Property({ columnType: 'varchar' })
  roundId!: string;

  @Property({ columnType: 'varchar' })
  gameId!: string;

  @Enum({ items: () => WagerKind, columnType: 'varchar' })
  kind!: WagerKind;

  @Property({ columnType: 'decimal(19,4)' })
  moneyAmount!: string; // nunca number

  @Property({ columnType: 'char(3)' })
  moneyCurrency!: string;

  @Property({ columnType: 'varchar', nullable: true })
  referenceExternalTransactionId?: string;

  @ManyToOne(() => WagerTransactionEntity, {
    fieldName: 'reference_transaction_id',
    columnType: 'uuid',
    nullable: true,
  })
  referenceTransaction?: WagerTransactionEntity;

  @Enum({ items: () => WagerStatus, columnType: 'varchar' })
  status!: WagerStatus;

  @Property({ columnType: 'varchar', nullable: true })
  failureCode?: string;

  @Property({ columnType: 'timestamptz', nullable: true })
  processedAt?: Date;

  @Property({ columnType: 'timestamptz', onCreate: () => new Date() })
  createdAt: Date = new Date();
}
