import { describe, it, expect } from 'bun:test';
import { InboxMessage } from './inbox-message';
import { DomainError } from '../../../shared/errors/domain.error';

describe('InboxMessage', () => {
  it('receive() cria mensagem não processada', () => {
    const m = InboxMessage.receive({ consumerName: 'wager-processor', messageId: 'm-1', payloadHash: 'h' });
    expect(m.consumerName).toBe('wager-processor');
    expect(m.messageId).toBe('m-1');
    expect(m.receivedAt).toBeInstanceOf(Date);
    expect(m.isProcessed()).toBe(false);
  });

  it('markProcessed() marca uma única vez', () => {
    const m = InboxMessage.receive({ consumerName: 'c', messageId: 'm', payloadHash: 'h' });
    const at = new Date();
    m.markProcessed(at);
    expect(m.isProcessed()).toBe(true);
    expect(m.processedAt).toBe(at);
    expect(() => m.markProcessed(new Date())).toThrow(DomainError);
  });

  it('exige consumerName e messageId', () => {
    expect(() => InboxMessage.receive({ consumerName: ' ', messageId: 'm', payloadHash: 'h' })).toThrow(DomainError);
    expect(() => InboxMessage.receive({ consumerName: 'c', messageId: '', payloadHash: 'h' })).toThrow(DomainError);
  });
});
