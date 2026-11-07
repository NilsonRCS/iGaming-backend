import { InvalidPayloadError } from '../application/errors';
import { ProcessWagerTransactionCommand } from '../application/use-cases/process-wager-transaction.use-case';

export type JsonObject = Record<string, unknown>;

export function asObject(body: unknown, name = 'body'): JsonObject {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new InvalidPayloadError([`${name} must be a JSON object`]);
  }
  return body as JsonObject;
}

/** Lê um campo opcional que é objeto (ex.: money); ausente vira {} para a validação apontar os campos. */
export function nestedObject(body: JsonObject, key: string): JsonObject {
  const value = body[key];
  if (value === undefined || value === null) return {};
  return asObject(value, key);
}

/**
 * Corpo JSON de uma transação → comando do use case. Compartilhado pela API HTTP
 * e pelo consumidor SQS: as duas entradas validam exatamente o mesmo formato.
 * Tipos errados passam adiante e são apontados pela validação do use case.
 */
export function wagerCommandFromJson(raw: unknown, idempotencyKey: string): ProcessWagerTransactionCommand {
  const body = asObject(raw);
  const money = nestedObject(body, 'money');
  return {
    idempotencyKey,
    providerId: body.providerId as string,
    externalTransactionId: body.externalTransactionId as string,
    walletId: body.walletId as string,
    playerId: body.playerId as string,
    roundId: body.roundId as string,
    gameId: body.gameId as string,
    kind: body.kind as string,
    amount: money.amount as string,
    currency: money.currency as string,
    referenceExternalTransactionId: body.referenceExternalTransactionId as string | null | undefined,
  };
}
