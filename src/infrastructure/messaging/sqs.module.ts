import { Module } from '@nestjs/common';
import { createSqsClient } from './sqs.config';

export const SQS_CLIENT = Symbol('SQS_CLIENT');

/** Cliente SQS único da app (consumidor, publisher, health e métricas). */
@Module({
  providers: [{ provide: SQS_CLIENT, useFactory: () => createSqsClient() }],
  exports: [SQS_CLIENT],
})
export class SqsModule {}
