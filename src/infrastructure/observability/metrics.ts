import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

export type Source = 'http' | 'sqs';

export interface OutboxSnapshot {
  pending: number;
  oldestAgeSeconds: number;
}

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/**
 * Métricas da seção 12. Registro próprio por app (não o global do prom-client):
 * várias apps no mesmo processo (testes) não colidem.
 */
export class Metrics {
  readonly registry = new Registry();

  // Transações por status / duplicatas
  readonly transactions = new Counter({
    name: 'wagering_transactions_total',
    help: 'Transações de wager novas, por origem, tipo e status final',
    labelNames: ['source', 'kind', 'status'] as const,
    registers: [this.registry],
  });
  readonly duplicates = new Counter({
    name: 'wagering_duplicates_total',
    help: 'Requisições/mensagens repetidas respondidas por replay idempotente',
    labelNames: ['source'] as const,
    registers: [this.registry],
  });
  readonly idempotencyConflicts = new Counter({
    name: 'wagering_idempotency_conflicts_total',
    help: 'Mesma chave de idempotência com payload divergente',
    labelNames: ['source'] as const,
    registers: [this.registry],
  });

  // Retries
  readonly retries = new Counter({
    name: 'wagering_retries_total',
    help: 'Novas tentativas: unique_violation (corrida entre instâncias), sqs_redelivery (erro transitório), outbox_publish',
    labelNames: ['operation'] as const,
    registers: [this.registry],
  });

  // DLQ
  readonly deadLettered = new Counter({
    name: 'sqs_dlq_messages_total',
    help: 'Mensagens enviadas à DLQ pelo consumidor (erro permanente)',
    labelNames: ['error_code'] as const,
    registers: [this.registry],
  });

  // Conflitos de lock
  readonly lockConflicts = new Counter({
    name: 'wallet_lock_conflicts_total',
    help: 'Lock da wallet já segurado por outra transação (FOR UPDATE NOWAIT falhou)',
    registers: [this.registry],
  });
  readonly lockWait = new Histogram({
    name: 'wallet_lock_wait_seconds',
    help: 'Espera para obter o lock da wallet (0 sem contenção)',
    buckets: [0, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [this.registry],
  });

  // Outbox
  readonly outboxPublishDelay = new Histogram({
    name: 'outbox_publish_delay_seconds',
    help: 'Tempo entre o commit do evento (occurred_at) e a publicação',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300],
    registers: [this.registry],
  });

  // Latência
  readonly processingDuration = new Histogram({
    name: 'wagering_processing_duration_seconds',
    help: 'Latência do processamento de uma transação (caso de uso completo)',
    labelNames: ['source', 'outcome'] as const,
    buckets: LATENCY_BUCKETS,
    registers: [this.registry],
  });
  readonly httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'Latência das requisições HTTP',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: LATENCY_BUCKETS,
    registers: [this.registry],
  });

  private outboxSource?: () => Promise<OutboxSnapshot>;
  private dlqDepthSource?: () => Promise<number>;
  private onSourceError?: (metric: string, error: unknown) => void;

  constructor() {
    collectDefaultMetrics({ register: this.registry });
    const self = this;

    // Lidos no scrape. Fonte indisponível → NaN (desconhecido), sem derrubar o /metrics.
    new Gauge({
      name: 'outbox_pending_messages',
      help: 'Eventos do outbox ainda não publicados',
      registers: [this.registry],
      async collect() {
        this.set(await self.read('outbox_pending_messages', async () => (await self.outboxSource?.())?.pending));
      },
    });
    new Gauge({
      name: 'outbox_lag_seconds',
      help: 'Idade do evento pendente mais antigo do outbox (0 sem pendentes)',
      registers: [this.registry],
      async collect() {
        this.set(await self.read('outbox_lag_seconds', async () => (await self.outboxSource?.())?.oldestAgeSeconds));
      },
    });
    new Gauge({
      name: 'sqs_dlq_depth',
      help: 'Mensagens na DLQ (inclui as movidas pelo redrive da fila)',
      registers: [this.registry],
      async collect() {
        this.set(await self.read('sqs_dlq_depth', async () => self.dlqDepthSource?.()));
      },
    });
  }

  setOutboxSource(source: () => Promise<OutboxSnapshot>): void {
    this.outboxSource = source;
  }

  setDlqDepthSource(source: () => Promise<number>): void {
    this.dlqDepthSource = source;
  }

  setSourceErrorHandler(handler: (metric: string, error: unknown) => void): void {
    this.onSourceError = handler;
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  private async read(metric: string, fn: () => Promise<number | undefined>): Promise<number> {
    try {
      const v = await fn();
      return v === undefined ? Number.NaN : v;
    } catch (error) {
      this.onSourceError?.(metric, error);
      return Number.NaN;
    }
  }
}
