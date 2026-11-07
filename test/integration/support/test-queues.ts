import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { randomUUID } from 'crypto';

/**
 * LocalStack real (o do docker compose, publicado no host na 4566).
 * Variável própria para não herdar AWS_ENDPOINT=http://localstack:4566 do .env.
 */
export const TEST_AWS_ENDPOINT = process.env.TEST_AWS_ENDPOINT ?? 'http://localhost:4566';

export function createTestSqsClient(): SQSClient {
  return new SQSClient({
    region: 'us-east-1',
    endpoint: TEST_AWS_ENDPOINT,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
}

export interface TestQueues {
  sqs: SQSClient;
  queueUrl: string;
  dlqUrl: string;
  /** Publica como um provedor faria: grupo = walletId, dedup explícito (único por padrão). */
  send(body: unknown, groupId: string, deduplicationId?: string): Promise<string>;
  /** Recebe (sem apagar) as mensagens visíveis de uma fila. */
  peek(url: string, visibilityTimeout?: number): Promise<Message[]>;
  /** Mensagens visíveis + em voo + atrasadas. */
  count(url: string): Promise<{ visible: number; inFlight: number }>;
  destroy(): Promise<void>;
}

/**
 * Par de filas FIFO descartáveis (principal + DLQ com redrive), exclusivo do teste:
 * as instâncias da app no compose consomem `wager-transactions.fifo`, nunca estas.
 */
export async function createTestQueues(
  label: string,
  opts: { maxReceiveCount?: number; visibilityTimeout?: number } = {},
): Promise<TestQueues> {
  const sqs = createTestSqsClient();
  const name = `test-${label}-${randomUUID().slice(0, 8)}`;
  const fifo = { FifoQueue: 'true', ContentBasedDeduplication: 'true' };

  const dlq = await sqs.send(new CreateQueueCommand({ QueueName: `${name}-dlq.fifo`, Attributes: fifo }));
  const dlqUrl = dlq.QueueUrl!;
  const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }));

  const main = await sqs.send(
    new CreateQueueCommand({
      QueueName: `${name}.fifo`,
      Attributes: {
        ...fifo,
        VisibilityTimeout: String(opts.visibilityTimeout ?? 30),
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: Attributes!.QueueArn,
          maxReceiveCount: String(opts.maxReceiveCount ?? 5),
        }),
      },
    }),
  );
  const queueUrl = main.QueueUrl!;

  return {
    sqs,
    queueUrl,
    dlqUrl,
    async send(body, groupId, deduplicationId = randomUUID()) {
      const r = await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
          MessageGroupId: groupId,
          MessageDeduplicationId: deduplicationId,
        }),
      );
      return r.MessageId!;
    },
    async peek(url, visibilityTimeout = 30) {
      const r = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: url,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 0,
          VisibilityTimeout: visibilityTimeout,
          MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
          MessageAttributeNames: ['All'],
        }),
      );
      return r.Messages ?? [];
    },
    async count(url) {
      const r = await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: url,
          AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
        }),
      );
      return {
        visible: Number(r.Attributes?.ApproximateNumberOfMessages ?? 0),
        inFlight: Number(r.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
      };
    },
    async destroy() {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl })).catch(() => undefined);
      await sqs.send(new DeleteQueueCommand({ QueueUrl: dlqUrl })).catch(() => undefined);
      sqs.destroy();
    },
  };
}

/** Espera uma condição assíncrona (polling curto), falhando após `timeoutMs`. */
export async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000, intervalMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
