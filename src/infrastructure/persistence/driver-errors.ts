import {
  ConnectionException,
  DeadlockException,
  LockWaitTimeoutException,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import { TransientInfrastructureError, UniqueViolationError } from '../../application/errors';

/** Erros de rede do Node/pg (sem SQLSTATE). */
const TRANSIENT_NODE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH']);

/**
 * SQLSTATE transitórios: repetir a operação mais tarde pode dar certo.
 * 08xxx conexão; 40001 serialização; 40P01 deadlock; 53300 conexões esgotadas;
 * 55P03 lock indisponível; 57P01/57P02/57P03 banco derrubado, em crash ou subindo.
 */
const TRANSIENT_SQLSTATES = new Set(['40001', '40P01', '53300', '55P03', '57P01', '57P02', '57P03']);

/**
 * Mensagens do pg/knex quando a conexão morre sem SQLSTATE útil (a transação em curso
 * perde a conexão: o knex só informa que a query da transação "já terminou").
 */
const TRANSIENT_MESSAGES = [
  /Connection terminated/i,
  /Transaction query already complete/i,
  /Timeout acquiring a connection/i,
  /timeout exceeded when trying to connect/i,
  /terminating connection/i,
];

interface DriverErrorShape {
  code?: string;
  sqlState?: string;
  severity?: string;
  message?: string;
  previous?: unknown;
  cause?: unknown;
}

function isTransientShape(e: DriverErrorShape): boolean {
  const code = e.sqlState ?? e.code ?? '';
  if (TRANSIENT_NODE_CODES.has(code) || TRANSIENT_SQLSTATES.has(code) || code.startsWith('08')) return true;
  // FATAL na abertura da conexão (ex.: 55000 "database is not currently accepting connections")
  if (e.severity === 'FATAL') return true;
  return TRANSIENT_MESSAGES.some((re) => re.test(e.message ?? ''));
}

/** Percorre a cadeia de causas (MikroORM guarda o erro original em `previous`). */
export function isTransientDriverError(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 5) return false;
  if (error instanceof ConnectionException || error instanceof DeadlockException || error instanceof LockWaitTimeoutException) {
    return true;
  }
  const e = error as DriverErrorShape;
  return isTransientShape(e) || isTransientDriverError(e.previous, depth + 1) || isTransientDriverError(e.cause, depth + 1);
}

/** Exceções do driver → erros da aplicação (UNIQUE violada, falha transitória). */
export function translateDriverError(error: unknown): unknown {
  if (error instanceof UniqueConstraintViolationException) {
    return new UniqueViolationError((error as unknown as { constraint?: string }).constraint);
  }
  if (isTransientDriverError(error)) {
    return new TransientInfrastructureError((error as Error).message, error);
  }
  return error;
}
