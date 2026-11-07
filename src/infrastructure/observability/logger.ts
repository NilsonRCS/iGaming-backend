import { LoggerService } from '@nestjs/common';
import pino, { DestinationStream, Logger } from 'pino';
import { currentLogContext } from './correlation';

/**
 * Nenhum log deve conter valores, saldos ou corpos de requisição/mensagem.
 * O redact é defesa em profundidade caso alguém logue um objeto desses por engano.
 */
export const REDACTED_PATHS = [
  'amount',
  'money',
  'balance',
  'payload',
  'body',
  '*.amount',
  '*.money',
  '*.balance',
  '*.payload',
  '*.body',
  'req.headers.authorization',
  'req.headers.cookie',
];

export function createLogger(destination?: DestinationStream, level = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino(
    {
      level,
      base: { service: 'igaming-backend', pid: process.pid },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      messageKey: 'msg',
      redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
      // correlationId / messageId da unidade de trabalho atual em toda linha
      mixin: () => ({ ...currentLogContext() }),
    },
    destination,
  );
}

let root: Logger | undefined;

/** Logger único do processo (Nest, Fastify e workers escrevem no mesmo stream JSON). */
export function rootLogger(): Logger {
  root ??= createLogger();
  return root;
}

/** Logger com campos estruturados usado pelos componentes da infraestrutura. */
export interface StructuredLogger {
  log(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function componentLogger(context: string, base: Logger = rootLogger()): StructuredLogger {
  const child = base.child({ context });
  return {
    log: (m, f) => child.info(f ?? {}, m),
    warn: (m, f) => child.warn(f ?? {}, m),
    error: (m, f) => child.error(f ?? {}, m),
  };
}

/** Logs do próprio Nest (bootstrap, rotas, exceções) no mesmo formato JSON. */
export class PinoNestLogger implements LoggerService {
  constructor(private readonly logger: Logger = rootLogger()) {}

  log(message: unknown, ...params: unknown[]) {
    this.write('info', message, params);
  }
  error(message: unknown, ...params: unknown[]) {
    this.write('error', message, params);
  }
  warn(message: unknown, ...params: unknown[]) {
    this.write('warn', message, params);
  }
  debug(message: unknown, ...params: unknown[]) {
    this.write('debug', message, params);
  }
  verbose(message: unknown, ...params: unknown[]) {
    this.write('trace', message, params);
  }
  fatal(message: unknown, ...params: unknown[]) {
    this.write('fatal', message, params);
  }

  /** O Nest passa o contexto como último parâmetro (e o stack antes dele, em error). */
  private write(level: pino.Level, message: unknown, params: unknown[]) {
    const context = typeof params[params.length - 1] === 'string' ? (params[params.length - 1] as string) : undefined;
    const stack = level === 'error' && params.length > 1 && typeof params[0] === 'string' ? params[0] : undefined;
    const fields: Record<string, unknown> = {};
    if (context) fields.context = context;
    if (stack) fields.stack = stack;
    if (message instanceof Error) {
      this.logger[level]({ ...fields, err: message }, message.message);
    } else if (typeof message === 'object' && message !== null) {
      this.logger[level]({ ...fields, ...(message as object) });
    } else {
      this.logger[level](fields, String(message));
    }
  }
}
