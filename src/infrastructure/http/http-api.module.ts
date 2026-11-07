import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { WageringModule } from '../wagering.module';
import { WalletsController } from './wallets.controller';
import { WageringController } from './wagering.controller';
import { ApplicationExceptionFilter } from './application-exception.filter';
import { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction.use-case';
import { InstrumentedWagerProcessor } from '../observability/instrumented-processor';
import { Metrics } from '../observability/metrics';
import { componentLogger } from '../observability/logger';
import { ObservabilityModule } from '../observability/observability.module';
import { HTTP_WAGER_PROCESSOR } from './tokens';

@Module({
  imports: [WageringModule, ObservabilityModule],
  controllers: [WalletsController, WageringController],
  providers: [
    { provide: APP_FILTER, useClass: ApplicationExceptionFilter },
    {
      provide: HTTP_WAGER_PROCESSOR,
      useFactory: (useCase: ProcessWagerTransactionUseCase, metrics: Metrics) =>
        new InstrumentedWagerProcessor(useCase, metrics, componentLogger('Wagering'), 'http'),
      inject: [ProcessWagerTransactionUseCase, Metrics],
    },
  ],
})
export class HttpApiModule {}
