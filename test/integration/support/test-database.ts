import { MikroORM, Options } from '@mikro-orm/postgresql';
import config from '../../../src/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { OpenWalletUseCase } from '../../../src/application/use-cases/open-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../../src/application/use-cases/process-wager-transaction.use-case';

/**
 * PostgreSQL real (o do docker compose, publicado no host na 5433).
 * Variáveis próprias para não herdar POSTGRES_HOST=postgres do .env (rede interna do compose).
 */
const host = process.env.TEST_POSTGRES_HOST ?? 'localhost';
const port = Number(process.env.TEST_POSTGRES_PORT ?? 5433);

export interface TestDatabase {
  orm: MikroORM;
  /** Opções do ORM apontando para o banco descartável (para montar a app Nest). */
  options: Options;
  openWallet: OpenWalletUseCase;
  processTransaction: ProcessWagerTransactionUseCase;
  sql<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
  destroy(): Promise<void>;
}

/**
 * Cria um banco exclusivo e aplica as migrations. O ledger é append-only
 * (UPDATE/DELETE/TRUNCATE bloqueados), então o isolamento é feito por banco descartável.
 */
export async function createTestDatabase(label: string): Promise<TestDatabase> {
  const dbName = `igaming_test_${label}_${process.pid}`;
  const base = { ...config, host, port, debug: false, migrations: { ...config.migrations, silent: true } };

  const admin = await MikroORM.init({ ...base, dbName: 'igaming', pool: { min: 0, max: 1 } });
  await admin.em.getConnection().execute(`drop database if exists "${dbName}" with (force)`);
  await admin.em.getConnection().execute(`create database "${dbName}"`);

  const options = { ...base, dbName, pool: { min: 0, max: 25 } } as Options;
  const orm = await MikroORM.init(options);
  await orm.getMigrator().up();

  const uow = new MikroOrmUnitOfWork(orm);

  return {
    orm,
    options,
    openWallet: new OpenWalletUseCase(uow),
    processTransaction: new ProcessWagerTransactionUseCase(uow),
    sql: (query, params = []) => orm.em.fork().getConnection().execute(query, params as never[]),
    async destroy() {
      await orm.close(true);
      await admin.em.getConnection().execute(`drop database if exists "${dbName}" with (force)`);
      await admin.close(true);
    },
  };
}
