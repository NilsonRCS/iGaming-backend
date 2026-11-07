import { describe, it, expect } from 'bun:test';
import { statusFor } from './application-exception.filter';
import { statusForResult } from './wagering.controller';
import {
  IdempotencyConflictError,
  InvalidPayloadError,
  TransactionNotFoundError,
  TransientInfrastructureError,
  UniqueViolationError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../application/errors';
import { ProcessWagerTransactionResult } from '../../application/use-cases/process-wager-transaction.use-case';

describe('Mapeamento de erros (seção 9.6)', () => {
  it.each([
    [new InvalidPayloadError(['x']), 400],
    [new WalletNotFoundError('w'), 404],
    [new TransactionNotFoundError('t'), 404],
    [new IdempotencyConflictError('k', 't'), 409],
    [new WalletAlreadyExistsError('p', 'BRL'), 409],
    [new TransientInfrastructureError('db fora'), 503],
    [new UniqueViolationError('uq'), 503],
  ])('%p → %d', (error, status) => {
    expect(statusFor(error)).toBe(status);
  });
});

describe('Status HTTP pelo resultado da transação', () => {
  const result = (status: string, idempotentReplay: boolean) =>
    ({ idempotentReplay, transaction: { status } }) as unknown as ProcessWagerTransactionResult;

  it.each([
    ['PROCESSED', false, 201],
    ['PROCESSED', true, 200],
    ['PENDING_REFERENCE', false, 202],
    ['PENDING_REFERENCE', true, 202],
    ['REJECTED', false, 422],
    ['REJECTED', true, 422],
    ['FAILED', true, 422],
  ])('%s (replay=%p) → %d', (status, replay, http) => {
    expect(statusForResult(result(status as string, replay as boolean))).toBe(http);
  });
});
