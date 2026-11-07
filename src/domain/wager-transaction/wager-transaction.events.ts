import { IntegrationEvent } from '../shared/events/integration-event';
import { WagerTransaction } from './wager-transaction';

type WagerTransactionEventPayload = {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: string;
  failureCode: string | null;
  processedAt: string | null;
};

function payloadOf(tx: WagerTransaction): WagerTransactionEventPayload {
  return {
    transactionId: tx.id,
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
  };
}

/** Transação aplicada (inclusive LOSS e OPENING). Aggregate = wallet (unidade de ordenação). */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionEventPayload> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction): WagerTransactionProcessed {
    return new WagerTransactionProcessed(tx.walletId, payloadOf(tx));
  }
}

/** Transação rejeitada por regra de negócio. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionEventPayload> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction): WagerTransactionRejected {
    return new WagerTransactionRejected(tx.walletId, payloadOf(tx));
  }
}

/** Transação aguardando a chegada da referência. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionEventPayload> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(tx.walletId, payloadOf(tx));
  }
}
