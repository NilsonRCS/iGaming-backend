import { IntegrationEvent } from '../shared/events/integration-event';
import { Wallet } from './wallet';
import { WalletLedgerEntry } from './wallet-ledger-entry';

type WalletBalanceChangedPayload = {
  walletId: string;
  playerId: string;
  transactionId: string;
  ledgerEntryId: string;
  direction: string;
  money: { amount: string; currency: string };
  balanceBefore: { amount: string; currency: string };
  balanceAfter: { amount: string; currency: string };
  walletVersion: number;
};

/** Emitido somente quando o saldo da wallet muda (há lançamento no ledger). */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedPayload> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry): WalletBalanceChanged {
    return new WalletBalanceChanged(wallet.id, {
      walletId: wallet.id,
      playerId: wallet.playerId,
      transactionId: entry.transactionId,
      ledgerEntryId: entry.id,
      direction: entry.direction,
      money: entry.money.toJSON(),
      balanceBefore: entry.balanceBefore.toJSON(),
      balanceAfter: entry.balanceAfter.toJSON(),
      walletVersion: wallet.version,
    });
  }
}
