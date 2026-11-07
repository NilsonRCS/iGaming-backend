import { SQSClient } from '@aws-sdk/client-sqs';

export interface SqsConsumerConfig {
  queueUrl: string;
  dlqUrl: string;
  consumerName: string;
  /** Long polling (máx. 20s no SQS). */
  waitTimeSeconds: number;
  /** Mensagens por ReceiveMessage (máx. 10). */
  maxMessages: number;
  backoffBaseSeconds: number;
  backoffMaxSeconds: number;
}

export function sqsConsumerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SqsConsumerConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`Missing environment variable ${name}`);
    return value;
  };
  return {
    queueUrl: required('SQS_QUEUE_URL'),
    dlqUrl: required('SQS_DLQ_URL'),
    consumerName: env.SQS_CONSUMER_NAME ?? 'wager-processor',
    waitTimeSeconds: Number(env.SQS_WAIT_TIME_SECONDS ?? 20),
    maxMessages: Number(env.SQS_MAX_MESSAGES ?? 10),
    backoffBaseSeconds: Number(env.SQS_BACKOFF_BASE_SECONDS ?? 5),
    backoffMaxSeconds: Number(env.SQS_BACKOFF_MAX_SECONDS ?? 300),
  };
}

export function sqsConsumerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.SQS_CONSUMER_ENABLED ?? 'true').toLowerCase() !== 'false';
}

export function createSqsClient(env: NodeJS.ProcessEnv = process.env): SQSClient {
  return new SQSClient({
    region: env.AWS_REGION ?? 'us-east-1',
    endpoint: env.AWS_ENDPOINT || undefined,
  });
}
