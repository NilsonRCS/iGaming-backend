import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { closeIdleConnectionsWhileClosing } from './infrastructure/http/graceful-shutdown';
import { PinoNestLogger, rootLogger } from './infrastructure/observability/logger';
import { requestCorrelationId } from './infrastructure/observability/http-observability';

async function bootstrap() {
  const logger = rootLogger();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    // Fastify e Nest no mesmo logger JSON; o id da requisição é o correlationId.
    // Entrada/saída de requisição são logadas pelos hooks de observabilidade (já com o correlationId).
    new FastifyAdapter({ logger, genReqId: requestCorrelationId, disableRequestLogging: true }),
    { bufferLogs: true },
  );
  app.useLogger(new PinoNestLogger(logger));

  // SIGTERM/SIGINT → hooks de shutdown: o consumidor SQS termina a mensagem em andamento
  // e devolve a visibilidade das demais antes de o processo sair.
  app.enableShutdownHooks();
  closeIdleConnectionsWhileClosing(app.getHttpAdapter().getInstance());

  const port = process.env.APP_PORT ?? 3000;
  await app.listen(port, '0.0.0.0');

  logger.info({ port: Number(port) }, 'iGaming Backend listening');
}

bootstrap();
