import { describe, expect, it } from 'bun:test';
import {
  IdempotencyConflictError,
  InvalidPayloadError,
  TransientInfrastructureError,
  UniqueViolationError,
  WalletNotFoundError,
} from '../../application/errors';
import { classifyError, retryDelaySeconds } from './message-disposition';

describe('classifyError', () => {
  it.each([
    ['payload inválido', new InvalidPayloadError(['x']), 'INVALID_PAYLOAD'],
    ['wallet inexistente', new WalletNotFoundError('w'), 'WALLET_NOT_FOUND'],
    ['conflito de idempotência', new IdempotencyConflictError('k', 't'), 'PAYLOAD_CONFLICT'],
  ])('%s é permanente → DLQ', (_, error, code) => {
    expect(classifyError(error)).toMatchObject({ action: 'dlq', code });
  });

  it('falha transitória de infraestrutura → retry', () => {
    expect(classifyError(new TransientInfrastructureError('db down'))).toMatchObject({
      action: 'retry',
      code: 'TRANSIENT_INFRASTRUCTURE_ERROR',
      reason: 'db down',
    });
  });

  it('UNIQUE ainda violada após os retries internos → retry (a próxima entrega enxerga a linha vencedora)', () => {
    expect(classifyError(new UniqueViolationError('uq'))).toMatchObject({ action: 'retry' });
  });

  it('erro desconhecido → retry (o redrive leva à DLQ após o limite)', () => {
    expect(classifyError(new Error('boom'))).toEqual({ action: 'retry', code: 'UNEXPECTED_ERROR', reason: 'boom' });
    expect(classifyError('texto')).toEqual({ action: 'retry', code: 'UNEXPECTED_ERROR', reason: 'texto' });
  });
});

describe('retryDelaySeconds', () => {
  it('dobra a cada entrega a partir da base', () => {
    expect([1, 2, 3, 4, 5].map((n) => retryDelaySeconds(n, 5, 300))).toEqual([5, 10, 20, 40, 80]);
  });

  it('respeita o teto', () => {
    expect(retryDelaySeconds(20, 5, 300)).toBe(300);
  });

  it('contagem ausente ou inválida conta como primeira entrega', () => {
    expect(retryDelaySeconds(0, 5, 300)).toBe(5);
    expect(retryDelaySeconds(Number.NaN, 5, 300)).toBe(5);
  });
});
