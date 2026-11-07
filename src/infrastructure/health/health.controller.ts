import { BeforeApplicationShutdown, Controller, Get, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { PostgresHealthIndicator, SqsHealthIndicator } from './health.indicators';

/** SIGTERM recebido: a instância deixa de aceitar tráfego novo (readiness 503) enquanto drena. */
@Injectable()
export class ShutdownState implements BeforeApplicationShutdown {
  draining = false;

  beforeApplicationShutdown(): void {
    this.draining = true;
  }
}

/** Seção 9.5: sem autenticação. */
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly postgres: PostgresHealthIndicator,
    private readonly sqs: SqsHealthIndicator,
    private readonly shutdown: ShutdownState,
  ) {}

  /** Processo vivo: não depende de nada externo (reiniciar não resolveria falha de banco/fila). */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** PostgreSQL e SQS alcançáveis. 503 com o componente `down`, ou `draining` no desligamento. */
  @Get('ready')
  @HealthCheck()
  ready() {
    if (this.shutdown.draining) {
      throw new ServiceUnavailableException({ status: 'error', error: { instance: { status: 'draining' } } });
    }
    return this.health.check([() => this.postgres.check(), () => this.sqs.check()]);
  }
}
