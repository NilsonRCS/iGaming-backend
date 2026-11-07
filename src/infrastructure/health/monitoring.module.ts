import { Inject, Injectable, Module, OnModuleInit } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { MikroORM } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { SQS_CLIENT, SqsModule } from '../messaging/sqs.module';
import { Metrics } from '../observability/metrics';
import { HealthController, ShutdownState } from './health.controller';
import { HEALTH_TIMEOUT_MS, PostgresHealthIndicator, SQS_HEALTH_QUEUES, SqsHealthIndicator } from './health.indicators';

function configuredQueues(env = process.env): string[] {
  return [env.SQS_QUEUE_URL, env.SQS_DLQ_URL, env.SQS_EVENTS_QUEUE_URL].filter((u): u is string => !!u);
}

/** Gauges lidos no scrape: outbox pendente/lag (PostgreSQL) e profundidade da DLQ (SQS). */
@Injectable()
class OperationalGauges implements OnModuleInit {
  constructor(
    private readonly metrics: Metrics,
    private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
  ) {}

  onModuleInit(): void {
    this.metrics.setOutboxSource(async () => {
      const [row] = await (this.orm.em.fork() as unknown as EntityManager).execute<{ pending: number; lag: string | null }[]>(
        `select count(*)::int as pending,
                coalesce(extract(epoch from now() - min(occurred_at)), 0)::float8 as lag
           from outbox_messages where published_at is null`,
      );
      return { pending: Number(row.pending), oldestAgeSeconds: Number(row.lag ?? 0) };
    });

    const dlqUrl = process.env.SQS_DLQ_URL;
    if (dlqUrl) {
      this.metrics.setDlqDepthSource(async () => {
        const r = await this.sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl: dlqUrl,
            AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible', 'ApproximateNumberOfMessagesDelayed'],
          }),
          { abortSignal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) },
        );
        const a = r.Attributes ?? {};
        return (
          Number(a.ApproximateNumberOfMessages ?? 0) +
          Number(a.ApproximateNumberOfMessagesNotVisible ?? 0) +
          Number(a.ApproximateNumberOfMessagesDelayed ?? 0)
        );
      });
    }
  }
}

/** `/health/live`, `/health/ready` e as métricas que dependem de PostgreSQL/SQS. */
@Module({
  imports: [TerminusModule.forRoot({ logger: false }), SqsModule],
  controllers: [HealthController],
  providers: [
    PostgresHealthIndicator,
    SqsHealthIndicator,
    { provide: SQS_HEALTH_QUEUES, useFactory: () => configuredQueues() },
    ShutdownState,
    OperationalGauges,
  ],
})
export class MonitoringModule {}

