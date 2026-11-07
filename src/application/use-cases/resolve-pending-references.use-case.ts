import { OutboxMessage } from '../../domain/shared/messaging/outbox-message';
import { FailureCode } from '../../domain/wager-transaction/failure-code.enum';
import { PendingReferencePolicy } from '../../domain/wager-transaction/pending-reference-policy';
import { WagerStatus } from '../../domain/wager-transaction/wager-transaction.enums';
import { WagerTransactionRejected } from '../../domain/wager-transaction/wager-transaction.events';
import { WagerTransaction } from '../../domain/wager-transaction/wager-transaction';
import { TransactionalRepositories, UnitOfWork } from '../ports/unit-of-work.port';
import { applyWagerTransaction } from './apply-wager-transaction';

/** Resultado de uma tentativa de resolução. */
export type ResolutionOutcome = 'processed' | 'rejected' | 'expired' | 'still_pending' | 'skipped';

export interface ResolvedTransaction {
  outcome: Exclude<ResolutionOutcome, 'skipped'>;
  transaction: WagerTransaction;
}

export interface ResolvePendingReferencesResult {
  candidates: number;
  processed: number;
  rejected: number;
  expired: number;
  stillPending: number;
  /** Outro worker pegou, já resolvida ou ainda não devida no momento do lock. */
  skipped: number;
  resolved: ResolvedTransaction[];
  /** Primeira falha de infraestrutura do lote (as demais candidatas seguem). */
  firstError?: unknown;
}

/**
 * Seção 7.4: reprocessa transações PENDING_REFERENCE devidas.
 * Cada candidata numa transação SQL própria, com o mesmo protocolo de lock da entrada:
 * wallet (FOR UPDATE) primeiro, depois a própria transação (SKIP LOCKED).
 */
export class ResolvePendingReferencesUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly policy: PendingReferencePolicy = PendingReferencePolicy.default(),
  ) {}

  async execute(batchSize: number): Promise<ResolvePendingReferencesResult> {
    const candidates = await this.uow.run((repos) => repos.transactions.findDuePendingReferences(batchSize));
    const result: ResolvePendingReferencesResult = {
      candidates: candidates.length,
      processed: 0,
      rejected: 0,
      expired: 0,
      stillPending: 0,
      skipped: 0,
      resolved: [],
    };

    for (const candidate of candidates) {
      try {
        const r = await this.uow.run((repos) => this.resolveOne(repos, candidate.id, candidate.walletId));
        if (!r) {
          result.skipped++;
          continue;
        }
        result.resolved.push(r);
        if (r.outcome === 'processed') result.processed++;
        else if (r.outcome === 'rejected') result.rejected++;
        else if (r.outcome === 'expired') result.expired++;
        else result.stillPending++;
      } catch (error) {
        // Rollback desta candidata; ela continua devida e volta no próximo ciclo
        result.firstError ??= error;
      }
    }
    return result;
  }

  private async resolveOne(repos: TransactionalRepositories, id: string, walletId: string): Promise<ResolvedTransaction | null> {
    const wallet = await repos.wallets.findByIdForUpdate(walletId);
    if (!wallet) return null;

    const claim = await repos.transactions.lockDuePendingReference(id);
    if (!claim) return null;
    const { transaction: tx, now } = claim;

    // Limite esgotado: REFERENCE_NOT_FOUND + evento (seção 7.4)
    if (this.policy.isExpired(tx.createdAt, now)) {
      tx.reject(FailureCode.REFERENCE_NOT_FOUND);
      await repos.transactions.updatePendingReference(tx);
      await repos.outbox.insert(OutboxMessage.enqueue(WagerTransactionRejected.from(tx)));
      return { outcome: 'expired', transaction: tx };
    }

    const outcome = await applyWagerTransaction(repos.transactions, tx, wallet);

    if (tx.status === WagerStatus.PENDING_REFERENCE) {
      // Sem mudança de estado: só agenda a próxima tentativa (nenhum evento novo)
      tx.scheduleReferenceRetry(now, this.policy);
      await repos.transactions.updatePendingReference(tx);
      return { outcome: 'still_pending', transaction: tx };
    }

    await repos.transactions.updatePendingReference(tx);
    if (outcome.ledgerEntry) {
      await repos.ledger.insert(outcome.ledgerEntry);
      await repos.wallets.update(wallet);
    }
    for (const event of outcome.events) {
      await repos.outbox.insert(OutboxMessage.enqueue(event));
    }
    return { outcome: tx.status === WagerStatus.PROCESSED ? 'processed' : 'rejected', transaction: tx };
  }
}
