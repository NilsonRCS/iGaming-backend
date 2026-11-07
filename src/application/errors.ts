/** Erros da camada de aplicação. A borda (HTTP/SQS) mapeia cada um para a resposta adequada. */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** Payload inválido (HTTP 400). Erro permanente: reenviar não muda o resultado. */
export class InvalidPayloadError extends ApplicationError {
  readonly code = 'INVALID_PAYLOAD';
  constructor(readonly issues: string[]) {
    super(`Invalid payload: ${issues.join('; ')}`);
  }
}

/** Mesma chave de idempotência (ou mesma transação externa) com payload diferente (HTTP 409). */
export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'PAYLOAD_CONFLICT';
  constructor(readonly idempotencyKey: string, readonly existingTransactionId: string) {
    super(`Idempotency conflict for key "${idempotencyKey}": payload differs from transaction ${existingTransactionId}`);
  }
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';
  constructor(readonly walletId: string) {
    super(`Wallet ${walletId} not found`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';
  constructor(readonly playerId: string, readonly currency: string) {
    super(`Wallet already exists for player ${playerId} in ${currency}`);
  }
}

/** Violação de UNIQUE detectada pelo banco: outra instância gravou a mesma chave primeiro. */
export class UniqueViolationError extends ApplicationError {
  readonly code = 'UNIQUE_VIOLATION';
  constructor(readonly constraint: string | undefined) {
    super(`Unique constraint violated: ${constraint ?? 'unknown'}`);
  }
}

/** Falha transitória de infraestrutura (HTTP 503 / retry no SQS). */
export class TransientInfrastructureError extends ApplicationError {
  readonly code = 'TRANSIENT_INFRASTRUCTURE_ERROR';
  constructor(message: string, readonly cause?: unknown) {
    super(message);
  }
}
