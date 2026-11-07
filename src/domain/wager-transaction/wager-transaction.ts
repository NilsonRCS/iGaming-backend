import { Money } from '../../shared/money/money';
import { DomainError } from '../../shared/errors/domain.error';
import { WagerKind, WagerStatus } from './wager-transaction.enums';
import { LedgerDirection } from '../wallet/ledger-direction.enum';
import { FailureCode } from './failure-code.enum';
import { randomUUID } from 'crypto';
import { PendingReferencePolicy } from './pending-reference-policy';

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
  /** Tentativas de resolução feitas pelo worker de PENDING_REFERENCE (seção 7.4). */
  referenceAttempts?: number;
  /** Próxima tentativa de resolução; ausente = no próximo ciclo do worker. */
  nextReferenceAttemptAt?: Date;
}

/** Identidade técnica da transação OPENING (não vem de provedor). */
export const SYSTEM_PROVIDER_ID = 'SYSTEM';

/** Tipos que cada operação pode referenciar (seção 7.2). */
const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerKind, ReadonlySet<WagerKind>>> = {
  [WagerKind.REFUND]: new Set([WagerKind.BET]),
  [WagerKind.ROLLBACK]: new Set([WagerKind.BET, WagerKind.WIN, WagerKind.REFUND]),
  [WagerKind.WIN]: new Set([WagerKind.BET]),
};

export type ReferenceEvaluation =
  | { outcome: 'VALID' }
  | { outcome: 'PENDING' }
  | { outcome: 'INVALID'; failureCode: FailureCode };

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

  /** Transação técnica que registra o saldo inicial de uma wallet. */
  static opening(params: {
    walletId: string;
    playerId: string;
    money: Money;
    payloadHash: string;
  }): WagerTransaction {
    const key = `OPENING:${params.walletId}`;
    return new WagerTransaction({
      id: randomUUID(),
      providerId: SYSTEM_PROVIDER_ID,
      externalTransactionId: key,
      idempotencyKey: key,
      payloadHash: params.payloadHash,
      walletId: params.walletId,
      playerId: params.playerId,
      roundId: WagerKind.OPENING,
      gameId: WagerKind.OPENING,
      kind: WagerKind.OPENING,
      money: params.money,
      status: WagerStatus.PENDING,
      createdAt: new Date(),
    });
  }

  static rehydrate(props: WagerTransactionProps): WagerTransaction {
    return new WagerTransaction({ ...props });
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

  /**
   * A referência ainda não pode ser aplicada: conta a tentativa e agenda a próxima (backoff da política).
   * Só faz sentido para quem continua PENDING_REFERENCE.
   */
  scheduleReferenceRetry(now: Date, policy: PendingReferencePolicy): void {
    if (this.props.status !== WagerStatus.PENDING_REFERENCE) {
      throw new DomainError(`Only PENDING_REFERENCE transactions can be rescheduled (status: ${this.props.status})`);
    }
    this.props.referenceAttempts = this.referenceAttempts + 1;
    this.props.nextReferenceAttemptAt = policy.nextAttemptAt(this.props.createdAt, this.props.referenceAttempts, now);
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

  hasReference(): boolean {
    return !!this.props.referenceExternalTransactionId;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  /** REFUND e ROLLBACK sempre usam referência; WIN usa quando informada. */
  usesReference(): boolean {
    return this.requiresReference() || (this.props.kind === WagerKind.WIN && this.hasReference());
  }

  /**
   * Avalia a transação referenciada (seção 7.2). Não cobre "já revertida",
   * que depende de consultar outras transações (responsabilidade do caso de uso).
   */
  evaluateReference(reference: WagerTransaction): ReferenceEvaluation {
    const allowed = ALLOWED_REFERENCE_KINDS[this.props.kind];
    if (!allowed || !allowed.has(reference.kind)) {
      return { outcome: 'INVALID', failureCode: FailureCode.INVALID_REFERENCE_KIND };
    }

    if (
      reference.providerId !== this.props.providerId ||
      reference.playerId !== this.props.playerId ||
      reference.walletId !== this.props.walletId ||
      reference.roundId !== this.props.roundId
    ) {
      return { outcome: 'INVALID', failureCode: FailureCode.REFERENCE_MISMATCH };
    }

    if (reference.money.currency !== this.props.money.currency) {
      return { outcome: 'INVALID', failureCode: FailureCode.CURRENCY_MISMATCH };
    }

    if (reference.status === WagerStatus.REJECTED || reference.status === WagerStatus.FAILED) {
      return { outcome: 'INVALID', failureCode: FailureCode.REFERENCE_NOT_PROCESSED };
    }

    if (reference.status !== WagerStatus.PROCESSED) {
      return { outcome: 'PENDING' };
    }

    if (this.isReversal() && !reference.money.equals(this.props.money)) {
      return { outcome: 'INVALID', failureCode: FailureCode.REFERENCE_AMOUNT_MISMATCH };
    }

    return { outcome: 'VALID' };
  }

  linkReference(reference: WagerTransaction): void {
    this.assertNotTerminal();
    this.props.referenceTransactionId = reference.id;
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
  get referenceAttempts(): number { return this.props.referenceAttempts ?? 0; }
  get nextReferenceAttemptAt(): Date | undefined { return this.props.nextReferenceAttemptAt; }
}
