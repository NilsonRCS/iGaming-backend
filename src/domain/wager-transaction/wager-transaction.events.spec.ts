import { describe, it, expect } from 'bun:test';
import { WagerTransaction } from './wager-transaction';
import { WagerKind } from './wager-transaction.enums';
import { FailureCode } from './failure-code.enum';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from './wager-transaction.events';
import { Wallet } from '../wallet/wallet';
import { WalletBalanceChanged } from '../wallet/wallet.events';
import { Money } from '../../shared/money/money';

const bet = () =>
  WagerTransaction.create({
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'h',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerKind.BET,
    money: Money.from('10.00', 'BRL'),
  });

describe('Eventos de integração', () => {
  it('WagerTransactionProcessed: envelope com tipo, versão, aggregate = wallet', () => {
    const tx = bet();
    tx.markProcessed();
    const json = WagerTransactionProcessed.from(tx).toJSON();
    expect(json.eventType).toBe('WagerTransactionProcessed');
    expect(json.version).toBe(1);
    expect(json.aggregateId).toBe('wallet-1');
    expect(json.eventId).toBeString();
    expect(json.payload).toMatchObject({
      transactionId: tx.id,
      kind: 'BET',
      status: 'PROCESSED',
      money: { amount: '10.00', currency: 'BRL' },
      failureCode: null,
    });
  });

  it('WagerTransactionRejected carrega o failureCode', () => {
    const tx = bet();
    tx.reject(FailureCode.INSUFFICIENT_BALANCE);
    const json = WagerTransactionRejected.from(tx).toJSON();
    expect(json.eventType).toBe('WagerTransactionRejected');
    expect(json.payload).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_BALANCE' });
  });

  it('WagerTransactionPendingReference', () => {
    const tx = bet();
    tx.markPendingReference();
    const json = WagerTransactionPendingReference.from(tx).toJSON();
    expect(json.eventType).toBe('WagerTransactionPendingReference');
    expect(json.payload).toMatchObject({ status: 'PENDING_REFERENCE' });
  });

  it('WalletBalanceChanged descreve saldo antes/depois e versão', () => {
    const w = Wallet.open({ playerId: 'player-1', initialBalance: Money.from('100.00', 'BRL') });
    const entry = w.debit(Money.from('30.00', 'BRL'), 'tx-1');
    const json = WalletBalanceChanged.from(w, entry).toJSON();
    expect(json.eventType).toBe('WalletBalanceChanged');
    expect(json.aggregateId).toBe(w.id);
    expect(json.payload).toEqual({
      walletId: w.id,
      playerId: 'player-1',
      transactionId: 'tx-1',
      ledgerEntryId: entry.id,
      direction: 'DEBIT',
      money: { amount: '30.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '70.00', currency: 'BRL' },
      walletVersion: 2,
    });
  });

  it('cada evento tem eventId próprio', () => {
    const tx = bet();
    tx.markProcessed();
    expect(WagerTransactionProcessed.from(tx).eventId).not.toBe(WagerTransactionProcessed.from(tx).eventId);
  });
});
