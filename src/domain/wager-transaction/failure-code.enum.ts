/**
 * Taxonomia de motivos de rejeição (status REJECTED) de uma WagerTransaction.
 * São resultados de negócio terminais: a mensagem é confirmada e não volta a ser processada.
 */
export enum FailureCode {
  INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',
  REFERENCE_NOT_FOUND = 'REFERENCE_NOT_FOUND',
  REFERENCE_ALREADY_REVERSED = 'REFERENCE_ALREADY_REVERSED',
  INVALID_REFERENCE_KIND = 'INVALID_REFERENCE_KIND',
  CURRENCY_MISMATCH = 'CURRENCY_MISMATCH',
  REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE = 'REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE',
  REFERENCE_EXPIRED = 'REFERENCE_EXPIRED',
  PAYLOAD_CONFLICT = 'PAYLOAD_CONFLICT',
  /** playerId da transação difere do dono da wallet */
  PLAYER_MISMATCH = 'PLAYER_MISMATCH',
  /** Referência pertence a outro player, wallet ou rodada */
  REFERENCE_MISMATCH = 'REFERENCE_MISMATCH',
  /** Referência existe mas terminou REJECTED ou FAILED */
  REFERENCE_NOT_PROCESSED = 'REFERENCE_NOT_PROCESSED',
  /** REFUND/ROLLBACK com valor diferente da referência (sem reversão parcial) */
  REFERENCE_AMOUNT_MISMATCH = 'REFERENCE_AMOUNT_MISMATCH',
}
