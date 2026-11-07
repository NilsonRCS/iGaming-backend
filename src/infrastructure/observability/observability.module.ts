import { Global, Module } from '@nestjs/common';
import { Metrics } from './metrics';
import { MetricsController } from './metrics.controller';
import { HttpObservability } from './http-observability';
import { componentLogger } from './logger';

/** Métricas (registro único por app), `/metrics` e hooks HTTP de correlação/latência. */
@Global()
@Module({
  providers: [
    {
      provide: Metrics,
      useFactory: () => {
        const metrics = new Metrics();
        const logger = componentLogger('Metrics');
        metrics.setSourceErrorHandler((metric, error) =>
          logger.warn('Metric source unavailable', { metric, error: error instanceof Error ? error.message : String(error) }),
        );
        return metrics;
      },
    },
    HttpObservability,
  ],
  controllers: [MetricsController],
  exports: [Metrics],
})
export class ObservabilityModule {}
