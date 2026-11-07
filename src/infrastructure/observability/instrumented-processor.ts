import { ApplicationError, IdempotencyConflictError } from '../../application/errors';
import {
  ProcessWagerTransactionCommand,
  ProcessWagerTransactionResult,
} from '../../application/use-cases/process-wager-transaction.use-case';
import { StructuredLogger } from './logger';
import { Metrics, Source } from './metrics';

export interface WagerProcessor {
  execute(command: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult>;
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/**
 * Métricas e log de cada transação, igual para HTTP e SQS (mesmo caso de uso, `source` diferente).
 * O log leva só identificadores e resultado: nunca valor, saldo ou payload.
 */
export class InstrumentedWagerProcessor implements WagerProcessor {
  constructor(
    private readonly inner: WagerProcessor,
    private readonly metrics: Metrics,
    private readonly logger: StructuredLogger,
    private readonly source: Source,
  ) {}

  async execute(command: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult> {
    const end = this.metrics.processingDuration.startTimer({ source: this.source });
    try {
      const result = await this.inner.execute(command);
      const tx = result.transaction;
      if (result.idempotentReplay) this.metrics.duplicates.inc({ source: this.source });
      else this.metrics.transactions.inc({ source: this.source, kind: tx.kind, status: tx.status });
      const seconds = end({ outcome: result.idempotentReplay ? 'REPLAY' : tx.status });

      this.logger.log('Wager transaction handled', {
        source: this.source,
        transactionId: tx.id,
        walletId: tx.walletId,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        kind: tx.kind,
        status: tx.status,
        failureCode: tx.failureCode,
        idempotentReplay: result.idempotentReplay,
        durationMs: Math.round(seconds * 1000),
      });
      return result;
    } catch (error) {
      const code = error instanceof ApplicationError ? error.code : 'UNEXPECTED_ERROR';
      if (error instanceof IdempotencyConflictError) this.metrics.idempotencyConflicts.inc({ source: this.source });
      const seconds = end({ outcome: code });

      this.logger.warn('Wager transaction not applied', {
        source: this.source,
        errorCode: code,
        walletId: str(command.walletId),
        providerId: str(command.providerId),
        externalTransactionId: str(command.externalTransactionId),
        kind: str(command.kind),
        durationMs: Math.round(seconds * 1000),
      });
      throw error;
    }
  }
}
