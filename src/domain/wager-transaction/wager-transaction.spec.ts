import { describe, it, expect } from 'bun:test';
import { WagerTransaction, WagerTransactionProps } from './wager-transaction';
import { WagerKind, WagerStatus } from './wager-transaction.enums';
import { LedgerDirection } from '../wallet/ledger-direction.enum';
import { Money } from '../../shared/money/money';
import { DomainError } from '../../shared/errors/domain.error';

const params = (kind: WagerKind, extra: Partial<WagerTransactionProps> = {}) => ({
  providerId: 'provider-a',
  externalTransactionId: `ext-${kind}`,
  idempotencyKey: `provider-a:ext-${kind}`,
  payloadHash: 'hash-1',
  walletId: 'wallet-1',
  playerId: 'player-1',
  roundId: 'round-1',
  gameId: 'game-1',
  kind,
  money: Money.from('10.00', 'BRL'),
  ...extra,
});

const create = (kind: WagerKind, extra: Partial<WagerTransactionProps> = {}) =>
  WagerTransaction.create(params(kind, extra));

describe('WagerTransaction', () => {
  describe('create()', () => {
    it('nasce PENDING, com id e createdAt', () => {
      const t = create(WagerKind.BET);
      expect(t.status).toBe(WagerStatus.PENDING);
      expect(t.id).toBeString();
      expect(t.createdAt).toBeInstanceOf(Date);
      expect(t.isTerminal()).toBe(false);
    });

    it('rejeita OPENING (não pode ser submetido via API nem fila)', () => {
      expect(() => create(WagerKind.OPENING)).toThrow(DomainError);
    });
  });

  describe('transições de estado', () => {
    it('markProcessed() é terminal e registra processedAt', () => {
      const t = create(WagerKind.BET);
      t.markProcessed();
      expect(t.status).toBe(WagerStatus.PROCESSED);
      expect(t.processedAt).toBeInstanceOf(Date);
      expect(t.isTerminal()).toBe(true);
    });

    it('reject() é terminal e registra failureCode', () => {
      const t = create(WagerKind.BET);
      t.reject('INSUFFICIENT_BALANCE');
      expect(t.status).toBe(WagerStatus.REJECTED);
      expect(t.failureCode).toBe('INSUFFICIENT_BALANCE');
      expect(t.isTerminal()).toBe(true);
    });

    it('fail() é terminal e registra failureCode', () => {
      const t = create(WagerKind.BET);
      t.fail('UNEXPECTED');
      expect(t.status).toBe(WagerStatus.FAILED);
      expect(t.failureCode).toBe('UNEXPECTED');
      expect(t.isTerminal()).toBe(true);
    });

    it('markPendingReference() não é terminal e permite transição posterior', () => {
      const t = create(WagerKind.REFUND, { referenceExternalTransactionId: 'ext-BET' });
      t.markPendingReference();
      expect(t.status).toBe(WagerStatus.PENDING_REFERENCE);
      expect(t.isTerminal()).toBe(false);

      t.markProcessed();
      expect(t.status).toBe(WagerStatus.PROCESSED);
    });

    const terminals: Array<[string, (t: WagerTransaction) => void]> = [
      ['PROCESSED', (t) => t.markProcessed()],
      ['REJECTED', (t) => t.reject('X')],
      ['FAILED', (t) => t.fail('X')],
    ];

    for (const [name, toTerminal] of terminals) {
      it(`${name} não transita para nenhum outro estado`, () => {
        const t = create(WagerKind.BET);
        toTerminal(t);
        expect(() => t.markProcessed()).toThrow(DomainError);
        expect(() => t.markPendingReference()).toThrow(DomainError);
        expect(() => t.reject('Y')).toThrow(DomainError);
        expect(() => t.fail('Y')).toThrow(DomainError);
        expect(t.status).toBe(name as WagerStatus);
      });
    }
  });

  describe('consultas de domínio', () => {
    it('affectsBalance() é false apenas para LOSS', () => {
      expect(create(WagerKind.LOSS).affectsBalance()).toBe(false);
      for (const k of [WagerKind.BET, WagerKind.WIN, WagerKind.REFUND, WagerKind.ROLLBACK]) {
        expect(create(k).affectsBalance()).toBe(true);
      }
    });

    it('requiresReference() é true apenas para REFUND e ROLLBACK', () => {
      expect(create(WagerKind.REFUND).requiresReference()).toBe(true);
      expect(create(WagerKind.ROLLBACK).requiresReference()).toBe(true);
      for (const k of [WagerKind.BET, WagerKind.WIN, WagerKind.LOSS]) {
        expect(create(k).requiresReference()).toBe(false);
      }
    });

    it('matchesPayload(): mesmo hash é replay, hash diferente é conflito', () => {
      const t = create(WagerKind.BET);
      expect(t.matchesPayload('hash-1')).toBe(true);
      expect(t.matchesPayload('hash-2')).toBe(false);
    });
  });

  describe('ledgerDirectionFor()', () => {
    it('BET → DEBIT', () => {
      expect(create(WagerKind.BET).ledgerDirectionFor()).toBe(LedgerDirection.DEBIT);
    });

    it('WIN → CREDIT', () => {
      expect(create(WagerKind.WIN).ledgerDirectionFor()).toBe(LedgerDirection.CREDIT);
    });

    it('REFUND → CREDIT', () => {
      expect(create(WagerKind.REFUND).ledgerDirectionFor()).toBe(LedgerDirection.CREDIT);
    });

    it('ROLLBACK de BET → CREDIT (inverso)', () => {
      expect(create(WagerKind.ROLLBACK).ledgerDirectionFor(create(WagerKind.BET))).toBe(LedgerDirection.CREDIT);
    });

    it('ROLLBACK de WIN → DEBIT (inverso)', () => {
      expect(create(WagerKind.ROLLBACK).ledgerDirectionFor(create(WagerKind.WIN))).toBe(LedgerDirection.DEBIT);
    });

    it('ROLLBACK de REFUND → DEBIT (inverso)', () => {
      expect(create(WagerKind.ROLLBACK).ledgerDirectionFor(create(WagerKind.REFUND))).toBe(LedgerDirection.DEBIT);
    });

    it('ROLLBACK sem referência lança erro de domínio', () => {
      expect(() => create(WagerKind.ROLLBACK).ledgerDirectionFor()).toThrow(DomainError);
    });

    it('LOSS não produz lançamento', () => {
      expect(() => create(WagerKind.LOSS).ledgerDirectionFor()).toThrow(DomainError);
    });
  });
});
