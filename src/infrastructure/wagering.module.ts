import { Module } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import { UNIT_OF_WORK, UnitOfWork } from '../application/ports/unit-of-work.port';
import { OpenWalletUseCase } from '../application/use-cases/open-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../application/use-cases/process-wager-transaction.use-case';
import { MikroOrmUnitOfWork } from './persistence/mikro-orm-unit-of-work';
import { MikroOrmReadModel } from './persistence/mikro-orm-read-model';
import { WAGERING_READ_MODEL, WageringReadModel } from '../application/ports/wagering-read-model.port';
import { WageringQueries } from '../application/queries/wagering-queries';
import { ObservabilityModule } from './observability/observability.module';
import { Metrics } from './observability/metrics';

/** Liga os casos de uso (sem dependência de framework) aos adaptadores de infraestrutura. */
@Module({
  imports: [ObservabilityModule],
  providers: [
    {
      provide: UNIT_OF_WORK,
      useFactory: (orm: MikroORM, metrics: Metrics) =>
        new MikroOrmUnitOfWork(orm, {
          conflict: () => metrics.lockConflicts.inc(),
          waited: (seconds) => metrics.lockWait.observe(seconds),
        }),
      inject: [MikroORM, Metrics],
    },
    {
      provide: OpenWalletUseCase,
      useFactory: (uow: UnitOfWork) => new OpenWalletUseCase(uow),
      inject: [UNIT_OF_WORK],
    },
    {
      provide: ProcessWagerTransactionUseCase,
      useFactory: (uow: UnitOfWork, metrics: Metrics) =>
        new ProcessWagerTransactionUseCase(uow, {
          uniqueViolationRetry: () => metrics.retries.inc({ operation: 'unique_violation' }),
        }),
      inject: [UNIT_OF_WORK, Metrics],
    },
    {
      provide: WAGERING_READ_MODEL,
      useFactory: (orm: MikroORM) => new MikroOrmReadModel(orm),
      inject: [MikroORM],
    },
    {
      provide: WageringQueries,
      useFactory: (read: WageringReadModel) => new WageringQueries(read),
      inject: [WAGERING_READ_MODEL],
    },
  ],
  exports: [UNIT_OF_WORK, OpenWalletUseCase, ProcessWagerTransactionUseCase, WageringQueries],
})
export class WageringModule {}
