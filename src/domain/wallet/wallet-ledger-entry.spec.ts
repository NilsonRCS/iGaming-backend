import { describe, it, expect } from 'bun:test';
import { WalletLedgerEntry } from './wallet-ledger-entry';
import { LedgerDirection } from './ledger-direction.enum';
import { Money } from '../../shared/money/money';

const brl = (v: string) => Money.from(v, 'BRL');

const base = {
  id: 'entry-1',
  walletId: 'wallet-1',
  transactionId: 'tx-1',
};

describe('WalletLedgerEntry', () => {
  it('CREDIT calcula balanceAfter = balanceBefore + money', () => {
    const e = WalletLedgerEntry.create({ ...base, direction: LedgerDirection.CREDIT, money: brl('25.50'), balanceBefore: brl('100.00') });
    expect(e.balanceAfter.amount).toBe('125.50');
    expect(e.isBalanced()).toBe(true);
  });

  it('DEBIT calcula balanceAfter = balanceBefore - money', () => {
    const e = WalletLedgerEntry.create({ ...base, direction: LedgerDirection.DEBIT, money: brl('80.00'), balanceBefore: brl('100.00') });
    expect(e.balanceAfter.amount).toBe('20.00');
    expect(e.isBalanced()).toBe(true);
  });

  it('preserva os identificadores e a direção', () => {
    const e = WalletLedgerEntry.create({ ...base, direction: LedgerDirection.DEBIT, money: brl('1.00'), balanceBefore: brl('1.00') });
    expect(e.id).toBe('entry-1');
    expect(e.walletId).toBe('wallet-1');
    expect(e.transactionId).toBe('tx-1');
    expect(e.direction).toBe(LedgerDirection.DEBIT);
    expect(e.createdAt).toBeInstanceOf(Date);
  });

  it('isBalanced() detecta aritmética inconsistente em dados reidratados', () => {
    const e = WalletLedgerEntry.rehydrate({
      ...base,
      direction: LedgerDirection.CREDIT,
      money: brl('10.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('999.00'),
      createdAt: new Date(),
    });
    expect(e.isBalanced()).toBe(false);
  });

  it('é imutável: não expõe setters nem métodos de transição', () => {
    const e = WalletLedgerEntry.create({ ...base, direction: LedgerDirection.CREDIT, money: brl('10.00'), balanceBefore: brl('0.00') });
    expect(() => {
      (e as unknown as { balanceAfter: Money }).balanceAfter = brl('1.00');
    }).toThrow();
    expect(e.balanceAfter.amount).toBe('10.00');
  });
});
