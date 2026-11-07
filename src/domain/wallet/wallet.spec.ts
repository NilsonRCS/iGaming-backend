import { describe, it, expect } from 'bun:test';
import { Wallet } from './wallet';
import { LedgerDirection } from './ledger-direction.enum';
import { Money } from '../../shared/money/money';
import { DomainError } from '../../shared/errors/domain.error';

const brl = (v: string) => Money.from(v, 'BRL');
const open = (balance = '100.00') => Wallet.open({ playerId: 'player-1', initialBalance: brl(balance) });

describe('Wallet', () => {
  describe('open()', () => {
    it('inicia com version 1 e o saldo inicial', () => {
      const w = open();
      expect(w.version).toBe(1);
      expect(w.balance.amount).toBe('100.00');
      expect(w.currency).toBe('BRL');
      expect(w.playerId).toBe('player-1');
    });
  });

  describe('debit()', () => {
    it('reduz o saldo, incrementa a versão e retorna lançamento DEBIT', () => {
      const w = open();
      const entry = w.debit(brl('80.00'), 'tx-1');

      expect(w.balance.amount).toBe('20.00');
      expect(w.version).toBe(2);
      expect(entry.direction).toBe(LedgerDirection.DEBIT);
      expect(entry.walletId).toBe(w.id);
      expect(entry.transactionId).toBe('tx-1');
      expect(entry.balanceBefore.amount).toBe('100.00');
      expect(entry.balanceAfter.amount).toBe('20.00');
      expect(entry.isBalanced()).toBe(true);
    });

    it('permite debitar exatamente o saldo, chegando a zero', () => {
      const w = open();
      w.debit(brl('100.00'), 'tx-1');
      expect(w.balance.isZero()).toBe(true);
    });

    it('rejeita saldo insuficiente sem alterar saldo nem versão', () => {
      const w = open();
      expect(() => w.debit(brl('100.01'), 'tx-1')).toThrow(DomainError);
      expect(w.balance.amount).toBe('100.00');
      expect(w.version).toBe(1);
    });

    it('cenário de duas apostas de 80.00 sobre saldo 100.00: só a primeira passa', () => {
      const w = open();
      w.debit(brl('80.00'), 'bet-1');
      expect(() => w.debit(brl('80.00'), 'bet-2')).toThrow(DomainError);
      expect(w.balance.amount).toBe('20.00');
      expect(w.version).toBe(2);
    });
  });

  describe('credit()', () => {
    it('aumenta o saldo, incrementa a versão e retorna lançamento CREDIT', () => {
      const w = open();
      const entry = w.credit(brl('50.25'), 'tx-1');

      expect(w.balance.amount).toBe('150.25');
      expect(w.version).toBe(2);
      expect(entry.direction).toBe(LedgerDirection.CREDIT);
      expect(entry.balanceBefore.amount).toBe('100.00');
      expect(entry.balanceAfter.amount).toBe('150.25');
      expect(entry.isBalanced()).toBe(true);
    });
  });

  describe('moeda', () => {
    it('rejeita débito em outra moeda sem alterar estado', () => {
      const w = open();
      expect(() => w.debit(Money.from('10.00', 'USD'), 'tx-1')).toThrow(DomainError);
      expect(w.balance.amount).toBe('100.00');
      expect(w.version).toBe(1);
    });

    it('rejeita crédito em outra moeda sem alterar estado', () => {
      const w = open();
      expect(() => w.credit(Money.from('10.00', 'USD'), 'tx-1')).toThrow(DomainError);
      expect(w.balance.amount).toBe('100.00');
      expect(w.version).toBe(1);
    });
  });

  describe('invariante saldo == ledger', () => {
    it('saldo final é reconstruível pelos lançamentos', () => {
      const w = open('0.00');
      const entries = [
        w.credit(brl('100.00'), 'opening'),
        w.debit(brl('30.00'), 'bet'),
        w.credit(brl('45.50'), 'win'),
        w.debit(brl('10.00'), 'bet-2'),
      ];

      const rebuilt = entries.reduce(
        (acc, e) => (e.direction === LedgerDirection.CREDIT ? acc.add(e.money) : acc.subtract(e.money)),
        Money.zero('BRL'),
      );

      expect(rebuilt.equals(w.balance)).toBe(true);
      expect(w.version).toBe(5);
    });
  });

  describe('rehydrate()', () => {
    it('restaura o estado persistido sem alterações', () => {
      const now = new Date();
      const w = Wallet.rehydrate({ id: 'w-1', playerId: 'p-1', balance: brl('42.00'), version: 7, createdAt: now, updatedAt: now });
      expect(w.id).toBe('w-1');
      expect(w.balance.amount).toBe('42.00');
      expect(w.version).toBe(7);
    });
  });

  describe('canDebit()', () => {
    it('true até o saldo exato; false acima dele; não altera estado', () => {
      const w = open();
      expect(w.canDebit(brl('100.00'))).toBe(true);
      expect(w.canDebit(brl('100.01'))).toBe(false);
      expect(w.balance.amount).toBe('100.00');
      expect(w.version).toBe(1);
    });

    it('moeda diferente é erro', () => {
      expect(() => open().canDebit(Money.from('1.00', 'USD'))).toThrow(DomainError);
    });
  });
});
