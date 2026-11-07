import { Wallet } from '../domain/wallet/wallet';
import { WagerTransaction } from '../domain/wager-transaction/wager-transaction';

export interface MoneyView {
  amount: string;
  currency: string;
}

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyView;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface WagerTransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyView;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: string;
  failureCode: string | null;
  processedAt: string | null;
  createdAt: string;
}

export interface LedgerEntryView {
  id: string;
  walletId: string;
  transactionId: string;
  direction: string;
  money: MoneyView;
  balanceBefore: MoneyView;
  balanceAfter: MoneyView;
  createdAt: string;
}

export interface LedgerPageView {
  items: LedgerEntryView[];
  nextCursor: string | null;
}

export function toWalletView(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

export function toTransactionView(tx: WagerTransaction): WagerTransactionView {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    processedAt: tx.processedAt?.toISOString() ?? null,
    createdAt: tx.createdAt.toISOString(),
  };
}
