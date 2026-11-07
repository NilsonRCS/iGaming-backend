import {
  ApplicationError,
  IdempotencyConflictError,
  InvalidPayloadError,
  TransientInfrastructureError,
  WalletNotFoundError,
} from '../../application/errors';

/**
 * O que fazer com uma mensagem cujo processamento lançou erro (seção 10).
 * Resultados de negócio (PROCESSED, REJECTED, PENDING_REFERENCE) não lançam: viram ACK direto.
 */
export type ErrorDisposition =
  | { action: 'dlq'; code: string; reason: string }
  | { action: 'retry'; code: string; reason: string };

/** Erros permanentes: reenviar a mesma mensagem nunca muda o resultado. */
const PERMANENT_ERRORS = [InvalidPayloadError, WalletNotFoundError, IdempotencyConflictError];

export function classifyError(error: unknown): ErrorDisposition {
  const code = error instanceof ApplicationError ? error.code : 'UNEXPECTED_ERROR';
  const reason = error instanceof Error ? error.message : String(error);

  if (PERMANENT_ERRORS.some((type) => error instanceof type)) {
    return { action: 'dlq', code, reason };
  }
  if (error instanceof TransientInfrastructureError) {
    return { action: 'retry', code, reason };
  }
  // Desconhecido: retry; esgotado o maxReceiveCount, o redrive da fila leva à DLQ.
  return { action: 'retry', code, reason };
}

/** Backoff exponencial pela contagem de entregas: base, 2×base, 4×base... limitado a `maxSeconds`. */
export function retryDelaySeconds(receiveCount: number, baseSeconds: number, maxSeconds: number): number {
  const attempt = Number.isFinite(receiveCount) ? Math.max(1, Math.floor(receiveCount)) : 1;
  return Math.min(baseSeconds * 2 ** (attempt - 1), maxSeconds);
}
