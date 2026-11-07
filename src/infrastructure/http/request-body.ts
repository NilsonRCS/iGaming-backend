import { InvalidPayloadError } from '../../application/errors';

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
