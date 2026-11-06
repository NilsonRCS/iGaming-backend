import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/core';

@Entity({ tableName: 'wallets' })
@Unique({ properties: ['playerId', 'currency'] })
export class WalletEntity {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @Property({ type: 'uuid', columnType: 'uuid' })
  playerId!: string;

  @Property({ columnType: 'char(3)' })
  currency!: string;

  @Property({ columnType: 'decimal(19,4)', check: 'balance_amount >= 0' })
  balanceAmount!: string; // string para preservar precisão — nunca number

  @Property({ columnType: 'char(3)' })
  balanceCurrency!: string;

  @Property({ columnType: 'integer', default: 1, version: true })
  version: number = 1;

  @Property({ columnType: 'timestamptz', onCreate: () => new Date() })
  createdAt: Date = new Date();

  @Property({ columnType: 'timestamptz', onUpdate: () => new Date(), onCreate: () => new Date() })
  updatedAt: Date = new Date();
}
