import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

@Entity({ tableName: 'outbox_messages' })
export class OutboxMessageEntity {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @Property({ columnType: 'varchar' })
  aggregateId!: string;

  @Property({ columnType: 'varchar' })
  eventType!: string;

  @Property({ columnType: 'jsonb' })
  payload!: Record<string, unknown>;

  @Property({ columnType: 'timestamptz' })
  occurredAt!: Date;

  @Property({ columnType: 'integer', default: 0 })
  attempts: number = 0;

  @Property({ columnType: 'timestamptz', nullable: true })
  nextAttemptAt?: Date;

  @Property({ columnType: 'timestamptz', nullable: true })
  publishedAt?: Date;
}
