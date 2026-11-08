import { Wallet } from '../../domain/wallet/wallet';
import { WagerTransaction } from '../../domain/wager-transaction/wager-transaction';
import { LedgerEntryView } from '../views';

/** Posição de um lançamento na ordenação do ledger (created_at DESC, id DESC). */
export interface LedgerPosition {
  /** Representação textual exata do created_at no banco (precisão de microssegundos). */
  createdAt: string;
  id: string;
}

export interface LedgerRow {
  entry: LedgerEntryView;
  position: LedgerPosition;
}

/** Saldo armazenado e soma do ledger lidos no mesmo snapshot (seção 9.4). Valores exatos do banco, como texto. */
export interface ReconciliationSnapshot {
  walletId: string;
  currency: string;
  storedBalance: string;
  /** Σ CREDIT − Σ DEBIT. */
  ledgerBalance: string;
  ledgerEntries: number;
  walletVersion: number;
  /** Relógio do banco no momento da leitura. */
  checkedAt: Date;
}

/** Leituras fora de transação de escrita (sem lock). */
export interface WageringReadModel {
  findWallet(id: string): Promise<Wallet | null>;
  findTransaction(id: string): Promise<WagerTransaction | null>;
  findTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  /** Lançamentos da wallet estritamente depois de `after`, do mais recente para o mais antigo. */
  listLedger(walletId: string, after: LedgerPosition | null, limit: number): Promise<LedgerRow[]>;
  /** null se a wallet não existe. */
  reconciliationSnapshot(walletId: string): Promise<ReconciliationSnapshot | null>;
}

export const WAGERING_READ_MODEL = Symbol('WAGERING_READ_MODEL');
