import { InvalidPayloadError } from '../../application/errors';
import { ProcessWagerTransactionCommand } from '../../application/use-cases/process-wager-transaction.use-case';
import { asObject, wagerCommandFromJson } from '../wager-command';

/**
 * Corpo da mensagem SQS → comando do use case. Mesmo formato do corpo HTTP,
 * com `idempotencyKey` dentro do corpo (na fila não há header).
 * JSON malformado vira InvalidPayloadError: erro permanente, vai para a DLQ.
 */
export function parseWagerMessage(body: string | undefined): ProcessWagerTransactionCommand {
  let raw: unknown;
  try {
    raw = JSON.parse(body ?? '');
  } catch {
    throw new InvalidPayloadError(['message body must be valid JSON']);
  }
  const idempotencyKey = asObject(raw).idempotencyKey;
  // Validação de tipo/presença fica no use case, junto com os demais campos.
  return wagerCommandFromJson(raw, idempotencyKey as string);
}
