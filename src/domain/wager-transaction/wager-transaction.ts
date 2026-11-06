import { Money } from '../../shared/money/money';
import { DomainError } from '../../shared/errors/domain.error';
import { WagerKind, WagerStatus } from './wager-transaction.enums';
import { LedgerDirection } from '../wallet/ledger-direction.enum';
import { randomUUID } from 'crypto';

export interface WagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerKind;
  money: Money;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  status: WagerStatus;
  failureCode?: string;
  processedAt?: Date;
  createdAt: Date;
}

const TERMINAL_STATUSES = new Set([
  WagerStatus.PROCESSED,
  WagerStatus.REJECTED,
  WagerStatus.FAILED,
]);

export class WagerTransaction {
  private constructor(private props: WagerTransactionProps) {}

  // ── Factories ──────────────────────────────────────────────────────────────

  static create(params: Omit<WagerTransactionProps, 'id' | 'status' | 'createdAt'>): WagerTransaction {
    if (params.kind === WagerKind.OPENING) {
      throw new DomainError('OPENING transactions cannot be submitted via API or queue');
    }

    return new WagerTransaction({
      ...params,
      id: randomUUID(),
      status: WagerStatus.PENDING,
      createdAt: new Date(),
    });
  }

  static rehydrate(props: WagerTransactionProps): WagerTransaction {
    return new WagerTransaction(props);
  }

  // ── Transições de estado ───────────────────────────────────────────────────

  markProcessed(): void {
    this.assertNotTerminal();
    this.props.status = WagerStatus.PROCESSED;
    this.props.processedAt = new Date();
  }

  markPendingReference(): void {
    this.assertNotTerminal();
    this.props.status = WagerStatus.PENDING_REFERENCE;
  }

  reject(failureCode: string): void {
    this.assertNotTerminal();
    this.props.status = WagerStatus.REJECTED;
    this.props.failureCode = failureCode;
    this.props.processedAt = new Date();
  }

  fail(failureCode: string): void {
    this.assertNotTerminal();
    this.props.status = WagerStatus.FAILED;
    this.props.failureCode = failureCode;
  }

  // ── Consultas de domínio ───────────────────────────────────────────────────

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this.props.status);
  }

  /** LOSS não afeta saldo — apenas registra o resultado da rodada */
  affectsBalance(): boolean {
    return this.props.kind !== WagerKind.LOSS;
  }

  /** REFUND e ROLLBACK precisam de uma transação de referência */
  requiresReference(): boolean {
    return this.props.kind === WagerKind.REFUND || this.props.kind === WagerKind.ROLLBACK;
  }

  /** Verifica se o payload recebido é idêntico ao já registrado (replay seguro) */
  matchesPayload(hash: string): boolean {
    return this.props.payloadHash === hash;
  }

  /** Determina a direção do lançamento no ledger */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.props.kind) {
      case WagerKind.BET:
        return LedgerDirection.DEBIT;

      case WagerKind.WIN:
      case WagerKind.REFUND:
        return LedgerDirection.CREDIT;

      case WagerKind.ROLLBACK: {
        if (!reference) {
          throw new DomainError('ROLLBACK requires a reference transaction to determine direction');
        }
        // Inverte a direção da referência
        return reference.ledgerDirectionFor() === LedgerDirection.DEBIT
          ? LedgerDirection.CREDIT
          : LedgerDirection.DEBIT;
      }

      default:
        throw new DomainError(`Transaction kind ${this.props.kind} does not produce a ledger entry`);
    }
  }

  // ── Validação ─────────────────────────────────────────────────────────────

  private assertNotTerminal(): void {
    if (this.isTerminal()) {
      throw new DomainError(
        `Cannot transition from terminal status: ${this.props.status}`,
      );
    }
  }

  // ── Acesso ────────────────────────────────────────────────────────────────

  get id(): string { return this.props.id; }
  get providerId(): string { return this.props.providerId; }
  get externalTransactionId(): string { return this.props.externalTransactionId; }
  get idempotencyKey(): string { return this.props.idempotencyKey; }
  get payloadHash(): string { return this.props.payloadHash; }
  get walletId(): string { return this.props.walletId; }
  get playerId(): string { return this.props.playerId; }
  get roundId(): string { return this.props.roundId; }
  get gameId(): string { return this.props.gameId; }
  get kind(): WagerKind { return this.props.kind; }
  get money(): Money { return this.props.money; }
  get referenceExternalTransactionId(): string | undefined { return this.props.referenceExternalTransactionId; }
  get referenceTransactionId(): string | undefined { return this.props.referenceTransactionId; }
  get status(): WagerStatus { return this.props.status; }
  get failureCode(): string | undefined { return this.props.failureCode; }
  get processedAt(): Date | undefined { return this.props.processedAt; }
  get createdAt(): Date { return this.props.createdAt; }
}
