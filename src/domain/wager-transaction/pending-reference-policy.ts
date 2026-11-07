import { DomainError } from '../../shared/errors/domain.error';

/**
 * Seção 7.4: quando reprocessar uma transação PENDING_REFERENCE e quando desistir.
 * Backoff exponencial limitado e TTL contado desde a criação da transação.
 */
export class PendingReferencePolicy {
  constructor(
    readonly baseMs: number,
    readonly maxMs: number,
    readonly ttlMs: number,
  ) {
    if (!(baseMs > 0) || !(maxMs >= baseMs) || !(ttlMs > 0)) {
      throw new DomainError('Invalid pending reference policy');
    }
  }

  /** 2s, 4s, 8s … 256s e depois a cada 5 min; TTL de 24h. */
  static default(): PendingReferencePolicy {
    return new PendingReferencePolicy(2_000, 5 * 60_000, 24 * 60 * 60_000);
  }

  expiresAt(createdAt: Date): Date {
    return new Date(createdAt.getTime() + this.ttlMs);
  }

  isExpired(createdAt: Date, now: Date): boolean {
    return now.getTime() >= this.expiresAt(createdAt).getTime();
  }

  /** Próxima tentativa depois da tentativa nº `attempts` (≥ 1); nunca depois do vencimento. */
  nextAttemptAt(createdAt: Date, attempts: number, now: Date): Date {
    const n = Math.max(1, Math.floor(attempts));
    const delay = Math.min(this.baseMs * 2 ** (n - 1), this.maxMs);
    return new Date(Math.min(now.getTime() + delay, this.expiresAt(createdAt).getTime()));
  }
}
