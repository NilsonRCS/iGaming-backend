import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  ProcessWagerTransactionCommand,
  ProcessWagerTransactionResult,
} from '../../application/use-cases/process-wager-transaction.use-case';
import { classifyError, ErrorDisposition, retryDelaySeconds } from './message-disposition';
import { SqsConsumerConfig } from './sqs.config';
import { parseWagerMessage } from './wager-message';
import { componentLogger, StructuredLogger } from '../observability/logger';
import { runWithLogContext, sanitizeCorrelationId } from '../observability/correlation';

export interface WagerTransactionProcessor {
  execute(command: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult>;
}

export type ConsumerLogger = StructuredLogger;

/** Pontos de observação (métricas) do consumidor. */
export interface ConsumerObserver {
  /** Erro transitório: a mensagem volta com backoff. */
  retried(errorCode: string): void;
  /** Erro permanente: mensagem enviada à DLQ. */
  deadLettered(errorCode: string): void;
}

/**
 * Resultado de uma mensagem dentro do lote. `blocked` trava o resto do grupo FIFO:
 * `delaySeconds` é a invisibilidade aplicada à mensagem que falhou (undefined = visibilidade não alterada).
 */
type Outcome = { kind: 'done' } | { kind: 'blocked'; delaySeconds?: number };

const RECEIVE_ERROR_PAUSE_MS = 1000;

/**
 * Consumidor de `wager-transactions.fifo` (seção 10).
 *
 * - Reutiliza o mesmo use case da API HTTP; o inbox é gravado na mesma transação SQL.
 * - ACK (DeleteMessage) somente depois do commit.
 * - Erro permanente → DLQ; transitório → visibilidade com backoff; após maxReceiveCount o redrive leva à DLQ.
 * - Ordem por grupo (walletId): se uma mensagem falha, as seguintes do mesmo grupo no lote ficam
 *   invisíveis pelo mesmo backoff, para nunca serem aplicadas antes dela.
 * - stop(): para de buscar, termina a mensagem em andamento e devolve a visibilidade das não iniciadas.
 */
export class SqsWagerConsumer {
  private running = false;
  private stopping = false;
  private loop?: Promise<void>;
  private receiveAbort?: AbortController;

  constructor(
    private readonly sqs: SQSClient,
    private readonly processor: WagerTransactionProcessor,
    private readonly config: SqsConsumerConfig,
    private readonly logger: ConsumerLogger = componentLogger('SqsWagerConsumer'),
    private readonly observer?: ConsumerObserver,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.logger.log('SQS consumer started', { queueUrl: this.config.queueUrl, consumerName: this.config.consumerName });
    this.loop = this.run();
  }

  /** Desligamento gracioso (SIGTERM). */
  async stop(): Promise<void> {
    this.stopping = true;
    this.running = false;
    this.receiveAbort?.abort();
    await this.loop;
    this.loop = undefined;
    this.logger.log('SQS consumer stopped', { consumerName: this.config.consumerName });
  }

  /** Um ciclo de receive + processamento. Exposto para testes determinísticos. */
  async pollOnce(): Promise<number> {
    const messages = await this.receive();
    await this.processBatch(messages);
    return messages.length;
  }

  async processBatch(messages: Message[]): Promise<void> {
    // grupo → invisibilidade da mensagem que falhou nele
    const blockedGroups = new Map<string, number | undefined>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? '';
      if (blockedGroups.has(group)) {
        // As seguintes do grupo voltam junto com a que falhou (nunca antes), preservando a ordem da wallet.
        const delay = blockedGroups.get(group);
        if (delay !== undefined) await this.release(message, delay);
        continue;
      }
      if (this.stopping) {
        await this.release(message, 0);
        continue;
      }
      const outcome = await this.handle(message);
      if (outcome.kind === 'blocked') blockedGroups.set(group, outcome.delaySeconds);
    }
  }

  private async run(): Promise<void> {
    while (this.running) {
      let messages: Message[];
      try {
        messages = await this.receive();
      } catch (error) {
        if (!this.running) break;
        this.logger.error('SQS receive failed', { error: describe(error) });
        await sleep(RECEIVE_ERROR_PAUSE_MS);
        continue;
      }
      await this.processBatch(messages);
    }
  }

  private async receive(): Promise<Message[]> {
    this.receiveAbort = new AbortController();
    const response = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.config.queueUrl,
        MaxNumberOfMessages: this.config.maxMessages,
        WaitTimeSeconds: this.config.waitTimeSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
        MessageAttributeNames: ['correlationId'],
      }),
      { abortSignal: this.receiveAbort.signal },
    );
    return response.Messages ?? [];
  }

  /** Cada mensagem roda no seu contexto de log: correlationId do produtor (ou o MessageId) + messageId. */
  private handle(message: Message): Promise<Outcome> {
    const messageId = message.MessageId ?? '';
    const correlationId = sanitizeCorrelationId(message.MessageAttributes?.correlationId?.StringValue) ?? messageId;
    return runWithLogContext({ correlationId, messageId }, () => this.handleInContext(message));
  }

  private async handleInContext(message: Message): Promise<Outcome> {
    const messageId = message.MessageId ?? '';
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
    const ctx = { messageId, receiveCount, consumerName: this.config.consumerName };

    let result: ProcessWagerTransactionResult;
    try {
      const command = parseWagerMessage(message.Body);
      result = await this.processor.execute({
        ...command,
        inbox: { consumerName: this.config.consumerName, messageId },
      });
    } catch (error) {
      return this.handleFailure(message, classifyError(error), ctx);
    }

    // Commit feito. Se o ACK falhar (ou o processo morrer aqui), a mensagem volta e o inbox faz replay.
    try {
      await this.delete(message);
    } catch (error) {
      this.logger.warn('ACK failed after commit; redelivery will be replayed by the inbox', { ...ctx, error: describe(error) });
    }
    this.logger.log('Message processed', {
      ...ctx,
      transactionId: result.transaction.id,
      walletId: result.transaction.walletId,
      providerId: result.transaction.providerId,
      status: result.transaction.status,
      idempotentReplay: result.idempotentReplay,
    });
    return { kind: 'done' };
  }

  private async handleFailure(
    message: Message,
    disposition: ErrorDisposition,
    ctx: { messageId: string; receiveCount: number },
  ): Promise<Outcome> {
    try {
      if (disposition.action === 'dlq') {
        await this.sendToDlq(message, disposition);
        this.observer?.deadLettered(disposition.code);
        this.logger.warn('Permanent error; message moved to DLQ', { ...ctx, errorCode: disposition.code });
        return { kind: 'done' };
      }
      const delay = retryDelaySeconds(ctx.receiveCount, this.config.backoffBaseSeconds, this.config.backoffMaxSeconds);
      await this.changeVisibility(message, delay);
      this.observer?.retried(disposition.code);
      this.logger.warn('Transient error; message will be retried', {
        ...ctx,
        errorCode: disposition.code,
        error: disposition.reason,
        retryInSeconds: delay,
      });
      return { kind: 'blocked', delaySeconds: delay };
    } catch (error) {
      // Sem DLQ/visibilidade: a mensagem volta sozinha quando o visibility timeout expirar.
      this.logger.error('Failed to settle message after error', { ...ctx, errorCode: disposition.code, error: describe(error) });
      return { kind: 'blocked' };
    }
  }

  /** Copia para a DLQ e só então remove da principal; a dedup da FIFO absorve um reenvio após crash. */
  private async sendToDlq(message: Message, disposition: ErrorDisposition): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.config.dlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dlq',
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: {
          errorCode: { DataType: 'String', StringValue: disposition.code },
          errorReason: { DataType: 'String', StringValue: disposition.reason.slice(0, 1024) },
          originalMessageId: { DataType: 'String', StringValue: message.MessageId ?? '' },
          consumerName: { DataType: 'String', StringValue: this.config.consumerName },
        },
      }),
    );
    await this.delete(message);
  }

  private async release(message: Message, seconds: number): Promise<void> {
    try {
      await this.changeVisibility(message, seconds);
    } catch (error) {
      this.logger.warn('Failed to release message', { messageId: message.MessageId, error: describe(error) });
    }
  }

  private delete(message: Message) {
    return this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.config.queueUrl, ReceiptHandle: message.ReceiptHandle }));
  }

  private changeVisibility(message: Message, seconds: number) {
    return this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.config.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
