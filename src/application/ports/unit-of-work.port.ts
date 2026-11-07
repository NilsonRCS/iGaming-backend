import { Wallet } from '../../domain/wallet/wallet';
import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { WagerTransaction } from '../../domain/wager-transaction/wager-transaction';
import { WagerKind } from '../../domain/wager-transaction/wager-transaction.enums';
import { OutboxMessage } from '../../domain/shared/messaging/outbox-message';
import { InboxMessage } from '../../domain/shared/messaging/inbox-message';

export interface WalletRepository {
  /** Lê a wallet com SELECT ... FOR UPDATE (lock da linha até o fim da transação). */
  findByIdForUpdate(id: string): Promise<Wallet | null>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null>;
  insert(wallet: Wallet): Promise<void>;
  /** Persiste saldo, versão e updatedAt. */
  update(wallet: Wallet): Promise<void>;
}

export interface WagerTransactionRepository {
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null>;
  findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  /** Existe transação PROCESSED do tipo `kind` revertendo `referenceTransactionId`? */
  existsProcessedReversal(referenceTransactionId: string, kind: WagerKind): Promise<boolean>;
  insert(transaction: WagerTransaction): Promise<void>;
  /** Seção 7.4: PENDING_REFERENCE devidas (sem lock), mais antigas primeiro. */
  findDuePendingReferences(limit: number): Promise<{ id: string; walletId: string }[]>;
  /**
   * Trava (FOR NO KEY UPDATE SKIP LOCKED) a transação se ainda estiver PENDING_REFERENCE e devida.
   * null se outro worker a pegou, se já foi resolvida ou se ainda não chegou a hora.
   * `now` é o relógio do banco.
   */
  lockDuePendingReference(id: string): Promise<{ transaction: WagerTransaction; now: Date } | null>;
  /** Persiste a resolução/reagendamento de uma transação que estava PENDING_REFERENCE. */
  updatePendingReference(transaction: WagerTransaction): Promise<void>;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
}

export interface OutboxRepository {
  insert(message: OutboxMessage): Promise<void>;
}

export interface InboxRepository {
  find(consumerName: string, messageId: string): Promise<InboxMessage | null>;
  insert(message: InboxMessage): Promise<void>;
}

export interface TransactionalRepositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
  inbox: InboxRepository;
}

/**
 * Executa `work` numa única transação SQL: tudo é confirmado junto ou nada é.
 * Implementações traduzem erros de driver para UniqueViolationError / TransientInfrastructureError.
 */
export interface UnitOfWork {
  run<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T>;
}

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
