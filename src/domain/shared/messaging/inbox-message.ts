import { DomainError } from '../../../shared/errors/domain.error';

export interface InboxMessageProps {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

/** Registro persistente de mensagem recebida; deduplicado por (consumerName, messageId). */
export class InboxMessage {
  private constructor(private readonly props: InboxMessageProps) {}

  static receive(params: { consumerName: string; messageId: string; payloadHash: string; receivedAt?: Date }): InboxMessage {
    if (!params.consumerName.trim() || !params.messageId.trim()) {
      throw new DomainError('Inbox message requires consumerName and messageId');
    }
    return new InboxMessage({
      consumerName: params.consumerName,
      messageId: params.messageId,
      payloadHash: params.payloadHash,
      receivedAt: params.receivedAt ?? new Date(),
    });
  }

  static rehydrate(props: InboxMessageProps): InboxMessage {
    return new InboxMessage({ ...props });
  }

  isProcessed(): boolean {
    return this.props.processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new DomainError(`Inbox message ${this.props.consumerName}/${this.props.messageId} is already processed`);
    }
    this.props.processedAt = at;
  }

  get consumerName(): string { return this.props.consumerName; }
  get messageId(): string { return this.props.messageId; }
  get payloadHash(): string { return this.props.payloadHash; }
  get receivedAt(): Date { return this.props.receivedAt; }
  get processedAt(): Date | undefined { return this.props.processedAt; }
}
