import { Logger } from '@nestjs/common';
import { PublishOutboxBatchResult } from '../../application/use-cases/publish-outbox-batch.use-case';
import { ConsumerLogger } from './sqs-wager-consumer';

export interface OutboxRelayConfig {
  batchSize: number;
  /** Espera quando o lote vem parcial ou vazio. */
  pollIntervalMs: number;
  /** Pausa após erro de infraestrutura (banco indisponível, por exemplo). */
  errorPauseMs: number;
}

export interface OutboxBatchPublisher {
  execute(batchSize: number): Promise<PublishOutboxBatchResult>;
}

/**
 * Worker do outbox: roda em toda instância; os ciclos concorrentes são seguros
 * porque cada um só publica o que reivindicou com FOR UPDATE SKIP LOCKED.
 * stop(): termina o lote em andamento (commit) e para.
 */
export class OutboxRelay {
  private running = false;
  private loop?: Promise<void>;
  private wake?: () => void;

  constructor(
    private readonly publishBatch: OutboxBatchPublisher,
    private readonly config: OutboxRelayConfig,
    private readonly logger: ConsumerLogger = nestLogger(),
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.logger.log('Outbox relay started', { batchSize: this.config.batchSize });
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.wake?.();
    await this.loop;
    this.loop = undefined;
    this.logger.log('Outbox relay stopped');
  }

  /** Um ciclo. Exposto para testes determinísticos. */
  runOnce(): Promise<PublishOutboxBatchResult> {
    return this.publishBatch.execute(this.config.batchSize);
  }

  private async run(): Promise<void> {
    while (this.running) {
      let pause = this.config.pollIntervalMs;
      try {
        const r = await this.runOnce();
        if (r.failed > 0) {
          this.logger.warn('Outbox publish failed; retry scheduled with backoff', {
            claimed: r.claimed,
            published: r.published,
            failed: r.failed,
            deferred: r.deferred,
            error: describe(r.firstError),
          });
        } else if (r.published > 0) {
          this.logger.log('Outbox events published', { published: r.published });
        }
        // Lote cheio sem falhas: provavelmente há mais pendentes, segue sem esperar
        if (r.claimed >= this.config.batchSize && r.failed === 0) pause = 0;
      } catch (error) {
        this.logger.error('Outbox relay cycle failed', { error: describe(error) });
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

function describe(error: unknown): string | undefined {
  if (error === undefined) return undefined;
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function nestLogger(): ConsumerLogger {
  const logger = new Logger(OutboxRelay.name);
  const fmt = (message: string, context?: Record<string, unknown>) => (context ? `${message} ${JSON.stringify(context)}` : message);
  return {
    log: (m, c) => logger.log(fmt(m, c)),
    warn: (m, c) => logger.warn(fmt(m, c)),
    error: (m, c) => logger.error(fmt(m, c)),
  };
}
