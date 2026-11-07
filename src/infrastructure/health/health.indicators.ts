import { Inject, Injectable } from '@nestjs/common';
import { HealthCheckError, HealthIndicator, HealthIndicatorResult } from '@nestjs/terminus';
import { MikroORM } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { SQS_CLIENT } from '../messaging/sqs.module';

export const HEALTH_TIMEOUT_MS = 2_000;

async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`timeout after ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([fn(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

@Injectable()
export class PostgresHealthIndicator extends HealthIndicator {
  constructor(private readonly orm: MikroORM) {
    super();
  }

  async check(key = 'postgres'): Promise<HealthIndicatorResult> {
    try {
      await withTimeout(HEALTH_TIMEOUT_MS, () => (this.orm.em.fork() as unknown as EntityManager).execute('select 1'));
      return this.getStatus(key, true);
    } catch (e) {
      throw new HealthCheckError('PostgreSQL unreachable', this.getStatus(key, false, { message: message(e) }));
    }
  }
}

/** Filas configuradas nesta instância (principal, DLQ, eventos). */
export const SQS_HEALTH_QUEUES = Symbol('SQS_HEALTH_QUEUES');

@Injectable()
export class SqsHealthIndicator extends HealthIndicator {
  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(SQS_HEALTH_QUEUES) private readonly queueUrls: string[],
  ) {
    super();
  }

  async check(key = 'sqs'): Promise<HealthIndicatorResult> {
    try {
      await withTimeout(HEALTH_TIMEOUT_MS, (abortSignal) =>
        Promise.all(
          this.queueUrls.map((QueueUrl) =>
            this.sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] }), { abortSignal }),
          ),
        ),
      );
      return this.getStatus(key, true, { queues: this.queueUrls.length });
    } catch (e) {
      throw new HealthCheckError('SQS unreachable', this.getStatus(key, false, { message: message(e) }));
    }
  }
}
