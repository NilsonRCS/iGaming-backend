import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { EventPublisher } from '../../application/ports/outbox.port';
import { OutboxMessage } from '../../domain/shared/messaging/outbox-message';

/**
 * Publica o envelope do evento na fila FIFO de eventos.
 * Grupo = wallet (ordem por wallet); dedup = eventId (republicação descartada pela fila
 * em até 5 min; depois disso o consumidor deduplica pelo eventId do envelope).
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
        MessageAttributes: {
          eventType: { DataType: 'String', StringValue: message.eventType },
          eventId: { DataType: 'String', StringValue: message.id },
        },
      }),
    );
  }
}
