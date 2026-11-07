import { BeforeApplicationShutdown, Inject, Module, OnApplicationBootstrap } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import { SQSClient } from '@aws-sdk/client-sqs';
import { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction.use-case';
import { PublishOutboxBatchUseCase } from '../../application/use-cases/publish-outbox-batch.use-case';
import { WageringModule } from '../wagering.module';
import { MikroOrmOutboxStore } from '../persistence/mikro-orm-outbox-store';
import {
  createSqsClient,
  eventsQueueUrlFromEnv,
  outboxPublisherEnabled,
  outboxRelayConfigFromEnv,
  sqsConsumerConfigFromEnv,
  sqsConsumerEnabled,
} from './sqs.config';
import { SqsWagerConsumer } from './sqs-wager-consumer';
import { SqsEventPublisher } from './sqs-event-publisher';
import { OutboxRelay } from './outbox-relay';

export const SQS_CLIENT = Symbol('SQS_CLIENT');
const WAGER_CONSUMER = Symbol('WAGER_CONSUMER');
const OUTBOX_RELAY = Symbol('OUTBOX_RELAY');

/**
 * Liga os workers ao ciclo de vida do Nest: iniciam no bootstrap e param no SIGTERM
 * (antes de o ORM fechar a conexão). Desligados por env, nem são construídos.
 */
class WorkersLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(
    @Inject(WAGER_CONSUMER) private readonly consumer: SqsWagerConsumer | null,
    @Inject(OUTBOX_RELAY) private readonly relay: OutboxRelay | null,
  ) {}

  onApplicationBootstrap(): void {
    this.consumer?.start();
    this.relay?.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all([this.consumer?.stop(), this.relay?.stop()]);
  }
}

@Module({
  imports: [WageringModule],
  providers: [
    { provide: SQS_CLIENT, useFactory: () => createSqsClient() },
    {
      provide: WAGER_CONSUMER,
      useFactory: (sqs: SQSClient, useCase: ProcessWagerTransactionUseCase) =>
        sqsConsumerEnabled() ? new SqsWagerConsumer(sqs, useCase, sqsConsumerConfigFromEnv()) : null,
      inject: [SQS_CLIENT, ProcessWagerTransactionUseCase],
    },
    {
      provide: OUTBOX_RELAY,
      useFactory: (sqs: SQSClient, orm: MikroORM) => {
        if (!outboxPublisherEnabled()) return null;
        const useCase = new PublishOutboxBatchUseCase(
          new MikroOrmOutboxStore(orm),
          new SqsEventPublisher(sqs, eventsQueueUrlFromEnv()),
        );
        return new OutboxRelay(useCase, outboxRelayConfigFromEnv());
      },
      inject: [SQS_CLIENT, MikroORM],
    },
    WorkersLifecycle,
  ],
  exports: [SQS_CLIENT],
})
export class MessagingModule {}
