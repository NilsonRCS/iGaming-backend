import { randomUUID } from 'crypto';
import { ResolvePendingReferencesResult } from '../../application/use-cases/resolve-pending-references.use-case';
import { componentLogger, StructuredLogger } from '../observability/logger';
import { runWithLogContext } from '../observability/correlation';

export interface PendingReferenceWorkerConfig {
  batchSize: number;
  /** Espera entre ciclos quando não há (mais) candidatas devidas. */
  pollIntervalMs: number;
  errorPauseMs: number;
}

export interface PendingReferenceResolver {
  execute(batchSize: number): Promise<ResolvePendingReferencesResult>;
}

/** Pontos de observação (métricas) do worker. */
export interface PendingReferenceObserver {
  cycle(result: ResolvePendingReferencesResult): void;
}

/**
 * Worker da seção 7.4: roda em toda instância. Ciclos concorrentes são seguros:
 * cada resolução trava a wallet e a própria transação (SKIP LOCKED) numa transação SQL.
 * stop(): termina o ciclo em andamento e para.
 */
export class PendingReferenceWorker {
  private running = false;
  private loop?: Promise<void>;
  private wake?: () => void;

  constructor(
    private readonly resolver: PendingReferenceResolver,
    private readonly config: PendingReferenceWorkerConfig,
    private readonly logger: StructuredLogger = componentLogger('PendingReferenceWorker'),
    private readonly observer?: PendingReferenceObserver,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.logger.log('Pending reference worker started', { batchSize: this.config.batchSize });
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.wake?.();
    await this.loop;
    this.loop = undefined;
    this.logger.log('Pending reference worker stopped');
  }

  /** Um ciclo, com correlationId próprio. Exposto para testes determinísticos. */
  runOnce(): Promise<ResolvePendingReferencesResult> {
    return runWithLogContext({ correlationId: `pending-ref-${randomUUID()}` }, async () => {
      const r = await this.resolver.execute(this.config.batchSize);
      this.observer?.cycle(r);
      for (const { outcome, transaction: tx } of r.resolved) {
        const fields = {
          outcome,
          transactionId: tx.id,
          walletId: tx.walletId,
          providerId: tx.providerId,
          kind: tx.kind,
          status: tx.status,
          failureCode: tx.failureCode,
          attempts: tx.referenceAttempts,
          nextAttemptAt: tx.nextReferenceAttemptAt?.toISOString(),
        };
        if (outcome === 'still_pending') this.logger.log('Pending reference still unresolved', fields);
        else this.logger.log('Pending reference resolved', fields);
      }
      if (r.firstError) {
        this.logger.warn('Pending reference resolution failed; will retry', {
          error: r.firstError instanceof Error ? r.firstError.message : String(r.firstError),
        });
      }
      return r;
    });
  }

  private async run(): Promise<void> {
    while (this.running) {
      let pause = this.config.pollIntervalMs;
      try {
        const r = await this.runOnce();
        // Lote cheio: provavelmente há mais devidas
        if (r.candidates >= this.config.batchSize && !r.firstError) pause = 0;
      } catch (error) {
        this.logger.error('Pending reference cycle failed', { error: error instanceof Error ? error.message : String(error) });
        pause = this.config.errorPauseMs;
      }
      if (pause > 0 && this.running) await this.sleep(pause);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    });
  }
}
