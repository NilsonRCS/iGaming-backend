import { describe, it, expect } from 'bun:test';
import { WagerTransaction, WagerTransactionProps } from './wager-transaction';
import { WagerKind, WagerStatus } from './wager-transaction.enums';
import { LedgerDirection } from '../wallet/ledger-direction.enum';
import { Money } from '../../shared/money/money';
import { DomainError } from '../../shared/errors/domain.error';
import { FailureCode } from './failure-code.enum';
import { SYSTEM_PROVIDER_ID } from './wager-transaction';

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

  describe('opening()', () => {
    it('cria OPENING do SYSTEM com chaves derivadas da wallet', () => {
      const t = WagerTransaction.opening({ walletId: 'w-1', playerId: 'p-1', money: Money.from('100.00', 'BRL'), payloadHash: 'h' });
      expect(t.kind).toBe(WagerKind.OPENING);
      expect(t.providerId).toBe(SYSTEM_PROVIDER_ID);
      expect(t.externalTransactionId).toBe('OPENING:w-1');
      expect(t.idempotencyKey).toBe('OPENING:w-1');
      expect(t.status).toBe(WagerStatus.PENDING);
    });
  });

  describe('usesReference()', () => {
    it('REFUND e ROLLBACK sempre; WIN só quando informada; BET e LOSS nunca', () => {
      expect(create(WagerKind.REFUND).usesReference()).toBe(true);
      expect(create(WagerKind.ROLLBACK).usesReference()).toBe(true);
      expect(create(WagerKind.WIN).usesReference()).toBe(false);
      expect(create(WagerKind.WIN, { referenceExternalTransactionId: 'ext-BET' }).usesReference()).toBe(true);
      expect(create(WagerKind.BET, { referenceExternalTransactionId: 'x' }).usesReference()).toBe(false);
      expect(create(WagerKind.LOSS, { referenceExternalTransactionId: 'x' }).usesReference()).toBe(false);
    });
  });

  describe('evaluateReference()', () => {
    const processed = (kind: WagerKind, extra: Partial<WagerTransactionProps> = {}) => {
      const t = create(kind, extra);
      t.markProcessed();
      return t;
    };

    it('REFUND de BET PROCESSED com mesmo valor é válido', () => {
      expect(create(WagerKind.REFUND).evaluateReference(processed(WagerKind.BET))).toEqual({ outcome: 'VALID' });
    });

    it('REFUND só referencia BET', () => {
      for (const k of [WagerKind.WIN, WagerKind.LOSS, WagerKind.REFUND, WagerKind.ROLLBACK]) {
        expect(create(WagerKind.REFUND).evaluateReference(processed(k))).toEqual({
          outcome: 'INVALID',
          failureCode: FailureCode.INVALID_REFERENCE_KIND,
        });
      }
    });

    it('ROLLBACK referencia BET, WIN ou REFUND; não LOSS nem ROLLBACK', () => {
      for (const k of [WagerKind.BET, WagerKind.WIN, WagerKind.REFUND]) {
        expect(create(WagerKind.ROLLBACK).evaluateReference(processed(k)).outcome).toBe('VALID');
      }
      for (const k of [WagerKind.LOSS, WagerKind.ROLLBACK]) {
        expect(create(WagerKind.ROLLBACK).evaluateReference(processed(k))).toEqual({
          outcome: 'INVALID',
          failureCode: FailureCode.INVALID_REFERENCE_KIND,
        });
      }
    });

    it('WIN só referencia BET', () => {
      expect(create(WagerKind.WIN).evaluateReference(processed(WagerKind.BET)).outcome).toBe('VALID');
      expect(create(WagerKind.WIN).evaluateReference(processed(WagerKind.LOSS))).toEqual({
        outcome: 'INVALID',
        failureCode: FailureCode.INVALID_REFERENCE_KIND,
      });
    });

    it('referência de outro player, wallet ou rodada → REFERENCE_MISMATCH', () => {
      for (const extra of [{ playerId: 'other' }, { walletId: 'other' }, { roundId: 'other' }, { providerId: 'other' }]) {
        expect(create(WagerKind.REFUND).evaluateReference(processed(WagerKind.BET, extra))).toEqual({
          outcome: 'INVALID',
          failureCode: FailureCode.REFERENCE_MISMATCH,
        });
      }
    });

    it('moeda diferente → CURRENCY_MISMATCH', () => {
      const ref = processed(WagerKind.BET, { money: Money.from('10.00', 'USD') });
      expect(create(WagerKind.REFUND).evaluateReference(ref)).toEqual({
        outcome: 'INVALID',
        failureCode: FailureCode.CURRENCY_MISMATCH,
      });
    });

    it('referência REJECTED ou FAILED → REFERENCE_NOT_PROCESSED', () => {
      const r1 = create(WagerKind.BET);
      r1.reject(FailureCode.INSUFFICIENT_BALANCE);
      const r2 = create(WagerKind.BET);
      r2.fail('X');
      for (const ref of [r1, r2]) {
        expect(create(WagerKind.REFUND).evaluateReference(ref)).toEqual({
          outcome: 'INVALID',
          failureCode: FailureCode.REFERENCE_NOT_PROCESSED,
        });
      }
    });

    it('referência ainda não terminal → PENDING', () => {
      const r1 = create(WagerKind.BET);
      const r2 = create(WagerKind.REFUND);
      r2.markPendingReference();
      expect(create(WagerKind.REFUND).evaluateReference(r1)).toEqual({ outcome: 'PENDING' });
      expect(create(WagerKind.ROLLBACK).evaluateReference(r2)).toEqual({ outcome: 'PENDING' });
    });

    it('valor diferente em REFUND/ROLLBACK → REFERENCE_AMOUNT_MISMATCH (sem reversão parcial)', () => {
      const ref = processed(WagerKind.BET, { money: Money.from('50.00', 'BRL') });
      for (const k of [WagerKind.REFUND, WagerKind.ROLLBACK]) {
        expect(create(k).evaluateReference(ref)).toEqual({
          outcome: 'INVALID',
          failureCode: FailureCode.REFERENCE_AMOUNT_MISMATCH,
        });
      }
    });

    it('WIN pode ter valor diferente do BET referenciado', () => {
      const ref = processed(WagerKind.BET, { money: Money.from('50.00', 'BRL') });
      expect(create(WagerKind.WIN).evaluateReference(ref).outcome).toBe('VALID');
    });
  });

  describe('linkReference()', () => {
    it('registra o id da referência', () => {
      const ref = create(WagerKind.BET);
      const t = create(WagerKind.REFUND);
      t.linkReference(ref);
      expect(t.referenceTransactionId).toBe(ref.id);
    });

    it('não altera transação terminal', () => {
      const t = create(WagerKind.REFUND);
      t.markProcessed();
      expect(() => t.linkReference(create(WagerKind.BET))).toThrow(DomainError);
    });
  });
});
