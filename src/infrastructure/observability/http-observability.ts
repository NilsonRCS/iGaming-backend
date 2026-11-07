import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { enterLogContext, isUuid, newCorrelationId, sanitizeCorrelationId } from './correlation';
import { Metrics } from './metrics';
import { componentLogger } from './logger';

export const CORRELATION_HEADER = 'x-correlation-id';

/** Id da requisição no Fastify: o do cliente (se seguro) ou um UUID novo. Usado em `genReqId`. */
export function requestCorrelationId(req: { headers: Record<string, unknown> }): string {
  return sanitizeCorrelationId(req.headers[CORRELATION_HEADER]) ?? newCorrelationId();
}

/**
 * Hooks do Fastify: correlationId em toda a requisição (contexto de log + header da resposta)
 * e latência por rota. Só age quando há servidor HTTP (no contexto sem HTTP dos workers, nada).
 */
@Injectable()
export class HttpObservability implements OnModuleInit {
  private readonly logger = componentLogger('Http');

  constructor(
    private readonly metrics: Metrics,
    @Optional() private readonly adapterHost?: HttpAdapterHost,
  ) {}

  onModuleInit(): void {
    const fastify = this.adapterHost?.httpAdapter?.getInstance?.() as FastifyInstance | undefined;
    if (!fastify || typeof fastify.addHook !== 'function') return;

    fastify.addHook('onRequest', (req: FastifyRequest, reply: FastifyReply, done: () => void) => {
      const correlationId =
        sanitizeCorrelationId(req.headers[CORRELATION_HEADER]) ?? (isUuid(req.id) ? req.id : newCorrelationId());
      reply.header(CORRELATION_HEADER, correlationId);
      enterLogContext({ correlationId });
      this.logger.log('HTTP request received', { method: req.method, url: req.url });
      done();
    });

    fastify.addHook('onResponse', (req: FastifyRequest, reply: FastifyReply, done: () => void) => {
      const route = req.routeOptions?.url ?? 'unmatched';
      this.metrics.httpDuration.observe(
        { method: req.method, route, status_code: String(reply.statusCode) },
        reply.elapsedTime / 1000,
      );
      this.logger.log('HTTP request completed', {
        method: req.method,
        route,
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      });
      done();
    });
  }
}
