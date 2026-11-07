import { EntityManager, MikroORM } from '@mikro-orm/core';
import type { EntityManager as SqlEntityManager } from '@mikro-orm/postgresql';
import { TransactionalRepositories, UnitOfWork } from '../../application/ports/unit-of-work.port';
import { WagerKind, WagerStatus } from '../../domain/wager-transaction/wager-transaction.enums';
import { WalletEntity } from './entities/wallet.entity';
import { WagerTransactionEntity } from './entities/wager-transaction.entity';
import { WalletLedgerEntryEntity } from './entities/wallet-ledger-entry.entity';
import { OutboxMessageEntity } from './entities/outbox-message.entity';
import { InboxMessageEntity } from './entities/inbox-message.entity';
import { toInboxMessage, toWagerTransaction, toWallet } from './mappers';
import { translateDriverError } from './driver-errors';

export { translateDriverError } from './driver-errors';

/** Observação do lock pessimista da wallet (métricas de conflito e espera). */
export interface WalletLockObserver {
  conflict(): void;
  waited(seconds: number): void;
}

const LOCK_NOT_AVAILABLE = '55P03';

/**
 * SELECT ... FOR UPDATE na wallet, medindo contenção com precisão:
 * tenta NOWAIT dentro de um savepoint; se outra transação segura a linha (55P03),
 * volta ao savepoint (a transação segue válida), conta o conflito e espera o lock normalmente.
 * A garantia é a mesma do FOR UPDATE simples: ao retornar, esta transação detém o lock.
 */
async function lockWallet(em: SqlEntityManager, id: string, observer?: WalletLockObserver): Promise<void> {
  await em.execute('savepoint wallet_lock');
  try {
    await em.execute('select 1 from wallets where id = ? for update nowait', [id]);
    await em.execute('release savepoint wallet_lock');
    observer?.waited(0);
    return;
  } catch (error) {
    if ((error as { code?: string })?.code !== LOCK_NOT_AVAILABLE) throw error;
    await em.execute('rollback to savepoint wallet_lock');
    await em.execute('release savepoint wallet_lock');
  }
  observer?.conflict();
  const started = performance.now();
  await em.execute('select 1 from wallets where id = ? for update', [id]);
  observer?.waited((performance.now() - started) / 1000);
}

/**
 * Escritas explícitas (em.insert / em.nativeUpdate): nada depende de flush implícito
 * do identity map, e cada comando SQL é emitido no ponto em que aparece no caso de uso.
 */
function repositories(em: EntityManager, lockObserver?: WalletLockObserver): TransactionalRepositories {
  return {
    wallets: {
      async findByIdForUpdate(id) {
        await lockWallet(em as unknown as SqlEntityManager, id, lockObserver);
        // Lido depois do lock: em READ COMMITTED cada comando vê o último commit
        const e = await em.findOne(WalletEntity, { id });
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
          referenceAttempts: t.referenceAttempts,
          nextReferenceAttemptAt: t.nextReferenceAttemptAt ?? null,
        });
      },
      async findDuePendingReferences(limit) {
        const rows = await (em as unknown as SqlEntityManager).execute<{ id: string; wallet_id: string }[]>(
          `select id, wallet_id from wager_transactions
            where status = 'PENDING_REFERENCE'
              and (next_reference_attempt_at is null or next_reference_attempt_at <= now())
            order by coalesce(next_reference_attempt_at, created_at), id
            limit ?`,
          [limit],
        );
        return rows.map((r) => ({ id: r.id, walletId: r.wallet_id }));
      },
      async lockDuePendingReference(id) {
        // NO KEY UPDATE: não bloqueia a verificação de FK de quem insere uma transação referenciando esta
        const rows = await (em as unknown as SqlEntityManager).execute<{ id: string; db_now: string | Date }[]>(
          `select id, now() as db_now from wager_transactions
            where id = ? and status = 'PENDING_REFERENCE'
              and (next_reference_attempt_at is null or next_reference_attempt_at <= now())
              for no key update skip locked`,
          [id],
        );
        if (rows.length === 0) return null;
        const e = await em.findOne(WagerTransactionEntity, { id }, { refresh: true });
        return e ? { transaction: toWagerTransaction(e), now: new Date(rows[0].db_now) } : null;
      },
      async updatePendingReference(t) {
        const affected = await em.nativeUpdate(
          WagerTransactionEntity,
          { id: t.id, status: WagerStatus.PENDING_REFERENCE },
          {
            status: t.status,
            failureCode: t.failureCode ?? null,
            referenceTransaction: t.referenceTransactionId ?? null,
            processedAt: t.processedAt ?? null,
            referenceAttempts: t.referenceAttempts,
            nextReferenceAttemptAt: t.nextReferenceAttemptAt ?? null,
          },
        );
        if (affected !== 1) throw new Error(`Pending reference ${t.id} changed concurrently`);
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
  constructor(
    private readonly orm: MikroORM,
    private readonly lockObserver?: WalletLockObserver,
  ) {}

  async run<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T> {
    try {
      // fork(): identity map isolado por transação — nada vaza entre requisições
      return await this.orm.em.fork().transactional((em) => work(repositories(em, this.lockObserver)));
    } catch (e) {
      throw translateDriverError(e);
    }
  }
}
