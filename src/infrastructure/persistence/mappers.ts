import { Money } from '../../shared/money/money';
import { Wallet } from '../../domain/wallet/wallet';
import { WagerTransaction } from '../../domain/wager-transaction/wager-transaction';
import { InboxMessage } from '../../domain/shared/messaging/inbox-message';
import { WalletEntity } from './entities/wallet.entity';
import { WagerTransactionEntity } from './entities/wager-transaction.entity';
import { InboxMessageEntity } from './entities/inbox-message.entity';

/** NUMERIC(19,4) chega como string ("100.0000"); o Money normaliza para 2 casas. */
const money = (amount: string, currency: string) => Money.from(amount, currency.trim());

export function toWallet(e: WalletEntity): Wallet {
  return Wallet.rehydrate({
    id: e.id,
    playerId: e.playerId,
    balance: money(e.balanceAmount, e.balanceCurrency),
    version: e.version,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  });
}

export function toWagerTransaction(e: WagerTransactionEntity): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: e.id,
    providerId: e.providerId,
    externalTransactionId: e.externalTransactionId,
    idempotencyKey: e.idempotencyKey,
    payloadHash: e.payloadHash,
    walletId: e.wallet.id,
    playerId: e.playerId,
    roundId: e.roundId,
    gameId: e.gameId,
    kind: e.kind,
    money: money(e.moneyAmount, e.moneyCurrency),
    referenceExternalTransactionId: e.referenceExternalTransactionId ?? undefined,
    referenceTransactionId: e.referenceTransaction?.id ?? undefined,
    status: e.status,
    failureCode: e.failureCode ?? undefined,
    processedAt: e.processedAt ?? undefined,
    createdAt: e.createdAt,
    referenceAttempts: e.referenceAttempts ?? 0,
    nextReferenceAttemptAt: e.nextReferenceAttemptAt ?? undefined,
  });
}

export function toInboxMessage(e: InboxMessageEntity): InboxMessage {
  return InboxMessage.rehydrate({
    consumerName: e.consumerName,
    messageId: e.messageId,
    payloadHash: e.payloadHash,
    receivedAt: e.receivedAt,
    processedAt: e.processedAt ?? undefined,
  });
}
