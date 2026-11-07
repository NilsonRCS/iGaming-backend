import {
  ConnectionException,
  DeadlockException,
  EntityManager,
  LockMode,
  LockWaitTimeoutException,
  MikroORM,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import { TransactionalRepositories, UnitOfWork } from '../../application/ports/unit-of-work.port';
import { TransientInfrastructureError, UniqueViolationError } from '../../application/errors';
import { WagerKind, WagerStatus } from '../../domain/wager-transaction/wager-transaction.enums';
import { WalletEntity } from './entities/wallet.entity';
import { WagerTransactionEntity } from './entities/wager-transaction.entity';
import { WalletLedgerEntryEntity } from './entities/wallet-ledger-entry.entity';
import { OutboxMessageEntity } from './entities/outbox-message.entity';
import { InboxMessageEntity } from './entities/inbox-message.entity';
import { toInboxMessage, toWagerTransaction, toWallet } from './mappers';

/** Erros de rede/conexão do driver pg que não viram exceções do MikroORM. */
const TRANSIENT_NODE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);

/** Exceções do driver → erros da aplicação (UNIQUE violada, falha transitória). */
export function translateDriverError(error: unknown): unknown {
  if (error instanceof UniqueConstraintViolationException) {
    return new UniqueViolationError((error as unknown as { constraint?: string }).constraint);
  }
  if (
    error instanceof ConnectionException ||
    error instanceof DeadlockException ||
    error instanceof LockWaitTimeoutException ||
    TRANSIENT_NODE_CODES.has((error as { code?: string })?.code ?? '')
  ) {
    return new TransientInfrastructureError((error as Error).message, error);
  }
  return error;
}

/**
 * Escritas explícitas (em.insert / em.nativeUpdate): nada depende de flush implícito
 * do identity map, e cada comando SQL é emitido no ponto em que aparece no caso de uso.
 */
function repositories(em: EntityManager): TransactionalRepositories {
  return {
    wallets: {
      async findByIdForUpdate(id) {
        const e = await em.findOne(WalletEntity, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
        return e ? toWallet(e) : null;
      },
      async findByPlayerAndCurrency(playerId, currency) {
        const e = await em.findOne(WalletEntity, { playerId, currency });
        return e ? toWallet(e) : null;
      },
      async insert(w) {
        await em.insert(WalletEntity, {
          id: w.id,
          playerId: w.playerId,
          currency: w.currency,
          balanceAmount: w.balance.amount,
          balanceCurrency: w.balance.currency,
          version: w.version,
          createdAt: w.createdAt,
          updatedAt: w.updatedAt,
        });
      },
      async update(w) {
        await em.nativeUpdate(
          WalletEntity,
          { id: w.id },
          { balanceAmount: w.balance.amount, version: w.version, updatedAt: w.updatedAt },
        );
      },
    },

    transactions: {
      async findByIdempotencyKey(idempotencyKey) {
        const e = await em.findOne(WagerTransactionEntity, { idempotencyKey });
        return e ? toWagerTransaction(e) : null;
      },
      async findByProviderAndExternalId(providerId, externalTransactionId) {
        const e = await em.findOne(WagerTransactionEntity, { providerId, externalTransactionId });
        return e ? toWagerTransaction(e) : null;
      },
      async existsProcessedReversal(referenceTransactionId, kind: WagerKind) {
        const n = await em.count(WagerTransactionEntity, {
          referenceTransaction: referenceTransactionId,
          kind,
          status: WagerStatus.PROCESSED,
        });
        return n > 0;
      },
      async insert(t) {
        await em.insert(WagerTransactionEntity, {
          id: t.id,
          providerId: t.providerId,
          externalTransactionId: t.externalTransactionId,
          idempotencyKey: t.idempotencyKey,
          payloadHash: t.payloadHash,
          wallet: t.walletId,
          playerId: t.playerId,
          roundId: t.roundId,
          gameId: t.gameId,
          kind: t.kind,
          moneyAmount: t.money.amount,
          moneyCurrency: t.money.currency,
          referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
          referenceTransaction: t.referenceTransactionId ?? null,
          status: t.status,
          failureCode: t.failureCode ?? null,
          processedAt: t.processedAt ?? null,
          createdAt: t.createdAt,
        });
      },
    },

    ledger: {
      async insert(l) {
        await em.insert(WalletLedgerEntryEntity, {
          id: l.id,
          wallet: l.walletId,
          transaction: l.transactionId,
          direction: l.direction,
          moneyAmount: l.money.amount,
          moneyCurrency: l.money.currency,
          balanceBeforeAmount: l.balanceBefore.amount,
          balanceAfterAmount: l.balanceAfter.amount,
          createdAt: l.createdAt,
        });
      },
    },

    outbox: {
      async insert(m) {
        await em.insert(OutboxMessageEntity, {
          id: m.id,
          aggregateId: m.aggregateId,
          eventType: m.eventType,
          payload: m.payload as unknown as Record<string, unknown>,
          occurredAt: m.occurredAt,
          attempts: m.attempts,
          nextAttemptAt: m.nextAttemptAt,
          publishedAt: m.publishedAt,
        });
      },
    },

    inbox: {
      async find(consumerName, messageId) {
        const e = await em.findOne(InboxMessageEntity, { consumerName, messageId });
        return e ? toInboxMessage(e) : null;
      },
      async insert(m) {
        await em.insert(InboxMessageEntity, {
          consumerName: m.consumerName,
          messageId: m.messageId,
          payloadHash: m.payloadHash,
          receivedAt: m.receivedAt,
          processedAt: m.processedAt,
        });
      },
    },
  };
}

export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly orm: MikroORM) {}

  async run<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T> {
    try {
      // fork(): identity map isolado por transação — nada vaza entre requisições
      return await this.orm.em.fork().transactional((em) => work(repositories(em)));
    } catch (e) {
      throw translateDriverError(e);
    }
  }
}
