import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  ApplicationError,
  IdempotencyConflictError,
  InvalidPayloadError,
  TransactionNotFoundError,
  TransientInfrastructureError,
  UniqueViolationError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../application/errors';

/** Mapeamento da seção 9.6: erro da aplicação → status HTTP. */
export function statusFor(error: ApplicationError): number {
  if (error instanceof InvalidPayloadError) return HttpStatus.BAD_REQUEST;
  if (error instanceof WalletNotFoundError || error instanceof TransactionNotFoundError) return HttpStatus.NOT_FOUND;
  if (error instanceof IdempotencyConflictError || error instanceof WalletAlreadyExistsError) return HttpStatus.CONFLICT;
  // UNIQUE ainda violada após as novas tentativas: disputa transitória, o cliente pode repetir
  if (error instanceof TransientInfrastructureError || error instanceof UniqueViolationError) {
    return HttpStatus.SERVICE_UNAVAILABLE;
  }
  return HttpStatus.INTERNAL_SERVER_ERROR;
}

@Catch()
export class ApplicationExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApplicationExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();

    if (exception instanceof ApplicationError) {
      const status = statusFor(exception);
      if (status >= 500) this.logger.warn(`${exception.code}: ${exception.message}`);
      if (status === HttpStatus.SERVICE_UNAVAILABLE) reply.header('Retry-After', '1');
      reply.status(status).send({
        error: exception.code,
        message: exception.message,
        ...(exception instanceof InvalidPayloadError ? { issues: exception.issues } : {}),
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      reply.status(status).send(
        typeof body === 'string' ? { error: HttpStatus[status] ?? 'HTTP_ERROR', message: body } : body,
      );
      return;
    }

    // Erros de parsing do Fastify (JSON malformado, content-type) trazem statusCode 4xx
    const fastifyStatus = (exception as { statusCode?: number })?.statusCode;
    if (typeof fastifyStatus === 'number' && fastifyStatus >= 400 && fastifyStatus < 500) {
      reply.status(fastifyStatus).send({ error: 'INVALID_REQUEST', message: (exception as Error).message });
      return;
    }

    this.logger.error(exception instanceof Error ? exception.stack ?? exception.message : String(exception));
    reply.status(HttpStatus.INTERNAL_SERVER_ERROR).send({ error: 'INTERNAL_ERROR', message: 'Internal server error' });
  }
}
