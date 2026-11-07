import { Module } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import { UNIT_OF_WORK, UnitOfWork } from '../application/ports/unit-of-work.port';
import { OpenWalletUseCase } from '../application/use-cases/open-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../application/use-cases/process-wager-transaction.use-case';
import { MikroOrmUnitOfWork } from './persistence/mikro-orm-unit-of-work';
import { MikroOrmReadModel } from './persistence/mikro-orm-read-model';
import { WAGERING_READ_MODEL, WageringReadModel } from '../application/ports/wagering-read-model.port';
import { WageringQueries } from '../application/queries/wagering-queries';

/** Liga os casos de uso (sem dependência de framework) aos adaptadores de infraestrutura. */
@Module({
  providers: [
    {
      provide: UNIT_OF_WORK,
      useFactory: (orm: MikroORM) => new MikroOrmUnitOfWork(orm),
      inject: [MikroORM],
    },
    {
      provide: OpenWalletUseCase,
      useFactory: (uow: UnitOfWork) => new OpenWalletUseCase(uow),
      inject: [UNIT_OF_WORK],
    },
    {
      provide: ProcessWagerTransactionUseCase,
      useFactory: (uow: UnitOfWork) => new ProcessWagerTransactionUseCase(uow),
      inject: [UNIT_OF_WORK],
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
