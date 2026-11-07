import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

/** Contexto de log da unidade de trabalho atual (requisição HTTP, mensagem SQS, ciclo do publisher). */
export interface LogContext {
  correlationId: string;
  messageId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

export function currentLogContext(): LogContext | undefined {
  return storage.getStore();
}

export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** Para hooks que não envolvem a continuação numa função (onRequest do Fastify). */
export function enterLogContext(context: LogContext): void {
  storage.enterWith(context);
}

const CORRELATION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Aceita o id do cliente só se for seguro para logs e headers; senão devolve undefined. */
export function sanitizeCorrelationId(value: unknown): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === 'string' && CORRELATION_ID_RE.test(v) ? v : undefined;
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function newCorrelationId(): string {
  return randomUUID();
}
