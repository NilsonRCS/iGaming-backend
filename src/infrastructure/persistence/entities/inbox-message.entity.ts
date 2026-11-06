import { Entity, PrimaryKeyProp, Property } from '@mikro-orm/core';

@Entity({ tableName: 'inbox_messages' })
export class InboxMessageEntity {
  // PK composta: (consumer_name, message_id) — garante dedup persistente
  [PrimaryKeyProp]?: ['consumerName', 'messageId'];

  @Property({ columnType: 'varchar', primary: true })
  consumerName!: string;

  @Property({ columnType: 'varchar', primary: true })
  messageId!: string;

  @Property({ columnType: 'varchar' })
  payloadHash!: string;

  @Property({ columnType: 'timestamptz' })
  receivedAt!: Date;

  @Property({ columnType: 'timestamptz', nullable: true })
  processedAt?: Date;
}
