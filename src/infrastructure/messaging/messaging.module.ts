import { BeforeApplicationShutdown, Inject, Module, OnApplicationBootstrap } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction.use-case';
import { WageringModule } from '../wagering.module';
import { createSqsClient, sqsConsumerConfigFromEnv, sqsConsumerEnabled } from './sqs.config';
import { SqsWagerConsumer } from './sqs-wager-consumer';

export const SQS_CLIENT = Symbol('SQS_CLIENT');

/** Liga o consumidor ao ciclo de vida do Nest: inicia no bootstrap e para no SIGTERM. */
class SqsConsumerLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(@Inject(SqsWagerConsumer) private readonly consumer: SqsWagerConsumer) {}

  onApplicationBootstrap(): void {
    if (sqsConsumerEnabled()) this.consumer.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.consumer.stop();
  }
}

@Module({
  imports: [WageringModule],
  providers: [
    { provide: SQS_CLIENT, useFactory: () => createSqsClient() },
    {
      provide: SqsWagerConsumer,
      useFactory: (sqs: SQSClient, useCase: ProcessWagerTransactionUseCase) =>
        new SqsWagerConsumer(sqs, useCase, sqsConsumerConfigFromEnv()),
      inject: [SQS_CLIENT, ProcessWagerTransactionUseCase],
    },
    SqsConsumerLifecycle,
  ],
  exports: [SQS_CLIENT],
})
export class MessagingModule {}
