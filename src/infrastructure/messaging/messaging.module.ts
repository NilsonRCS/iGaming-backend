import { BeforeApplicationShutdown, Inject, Module, OnApplicationBootstrap } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import { SQSClient } from '@aws-sdk/client-sqs';
import { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction.use-case';
import { PublishOutboxBatchUseCase } from '../../application/use-cases/publish-outbox-batch.use-case';
import { WageringModule } from '../wagering.module';
import { MikroOrmOutboxStore } from '../persistence/mikro-orm-outbox-store';
import {
  eventsQueueUrlFromEnv,
  outboxPublisherEnabled,
  outboxRelayConfigFromEnv,
  sqsConsumerConfigFromEnv,
  sqsConsumerEnabled,
} from './sqs.config';
import { SqsWagerConsumer } from './sqs-wager-consumer';
import { SqsEventPublisher } from './sqs-event-publisher';
import { OutboxRelay } from './outbox-relay';
import { withKillAfterCommit, withKillAfterPublish } from './fault-injection';
import { SQS_CLIENT, SqsModule } from './sqs.module';
import { Metrics } from '../observability/metrics';
import { InstrumentedWagerProcessor } from '../observability/instrumented-processor';
import { componentLogger } from '../observability/logger';

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
  imports: [WageringModule, SqsModule],
  providers: [
    {
      provide: WAGER_CONSUMER,
      useFactory: (sqs: SQSClient, useCase: ProcessWagerTransactionUseCase, metrics: Metrics) => {
        if (!sqsConsumerEnabled()) return null;
        const processor = new InstrumentedWagerProcessor(useCase, metrics, componentLogger('Wagering'), 'sqs');
        return new SqsWagerConsumer(sqs, withKillAfterCommit(processor), sqsConsumerConfigFromEnv(), undefined, {
          retried: () => metrics.retries.inc({ operation: 'sqs_redelivery' }),
          deadLettered: (code) => metrics.deadLettered.inc({ error_code: code }),
        });
      },
      inject: [SQS_CLIENT, ProcessWagerTransactionUseCase, Metrics],
    },
    {
      provide: OUTBOX_RELAY,
      useFactory: (sqs: SQSClient, orm: MikroORM, metrics: Metrics) => {
        if (!outboxPublisherEnabled()) return null;
        const useCase = new PublishOutboxBatchUseCase(
          new MikroOrmOutboxStore(orm),
          withKillAfterPublish(new SqsEventPublisher(sqs, eventsQueueUrlFromEnv())),
        );
        return new OutboxRelay(useCase, outboxRelayConfigFromEnv(), undefined, {
          published: (delays) => delays.forEach((d) => metrics.outboxPublishDelay.observe(d)),
          failed: (n) => metrics.retries.inc({ operation: 'outbox_publish' }, n),
        });
      },
      inject: [SQS_CLIENT, MikroORM, Metrics],
    },
    WorkersLifecycle,
  ],
})
export class MessagingModule {}
