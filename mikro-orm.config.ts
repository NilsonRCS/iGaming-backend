import { defineConfig, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { WalletEntity } from './src/infrastructure/persistence/entities/wallet.entity';
import { WagerTransactionEntity } from './src/infrastructure/persistence/entities/wager-transaction.entity';
import { WalletLedgerEntryEntity } from './src/infrastructure/persistence/entities/wallet-ledger-entry.entity';
import { InboxMessageEntity } from './src/infrastructure/persistence/entities/inbox-message.entity';
import { OutboxMessageEntity } from './src/infrastructure/persistence/entities/outbox-message.entity';

export default defineConfig({
  driver: PostgreSqlDriver,
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  dbName: process.env.POSTGRES_DB ?? 'igaming',
  user: process.env.POSTGRES_USER ?? 'igaming',
  password: process.env.POSTGRES_PASSWORD ?? 'igaming',

  // Entidades explícitas (mais seguro que glob em produção)
  entities: [
    WalletEntity,
    WagerTransactionEntity,
    WalletLedgerEntryEntity,
    InboxMessageEntity,
    OutboxMessageEntity,
  ],
  entitiesTs: [
    WalletEntity,
    WagerTransactionEntity,
    WalletLedgerEntryEntity,
    InboxMessageEntity,
    OutboxMessageEntity,
  ],

  // Desabilita o autoJoin implícito para manter controle explícito
  autoJoinOneToOneOwner: false,

  // Migrations
  extensions: [Migrator],
  migrations: {
    path: 'dist/infrastructure/persistence/migrations',
    pathTs: 'src/infrastructure/persistence/migrations',
    glob: '!(*.d).{js,ts}',
    transactional: true,
    allOrNothing: true,
    snapshot: false,
  },

  // Debug apenas em desenvolvimento
  debug: process.env.NODE_ENV === 'development',
});
