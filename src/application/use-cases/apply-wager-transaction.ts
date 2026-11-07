import { Wallet } from '../../domain/wallet/wallet';
import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { LedgerDirection } from '../../domain/wallet/ledger-direction.enum';
import { WalletBalanceChanged } from '../../domain/wallet/wallet.events';
import { WagerTransaction } from '../../domain/wager-transaction/wager-transaction';
import { FailureCode } from '../../domain/wager-transaction/failure-code.enum';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../../domain/wager-transaction/wager-transaction.events';
import { IntegrationEvent } from '../../domain/shared/events/integration-event';
import { WagerTransactionRepository } from '../ports/unit-of-work.port';

export interface ApplyOutcome {
  /** Presente somente quando o saldo mudou. */
  ledgerEntry?: WalletLedgerEntry;
  events: IntegrationEvent[];
}

function rejected(tx: WagerTransaction, code: FailureCode): ApplyOutcome {
  tx.reject(code);
  return { events: [WagerTransactionRejected.from(tx)] };
}

function pending(tx: WagerTransaction): ApplyOutcome {
  tx.markPendingReference();
  return { events: [WagerTransactionPendingReference.from(tx)] };
}

/**
 * Aplica as regras de negócio (seção 7) a uma transação PENDING ou PENDING_REFERENCE.
 * Pré-condição: a wallet foi lida com lock (SELECT ... FOR UPDATE) na transação SQL corrente.
 * Muta `tx` e `wallet` em memória; a persistência é responsabilidade do chamador.
 */
export async function applyWagerTransaction(
  transactions: WagerTransactionRepository,
  tx: WagerTransaction,
  wallet: Wallet,
): Promise<ApplyOutcome> {
  if (wallet.playerId !== tx.playerId) return rejected(tx, FailureCode.PLAYER_MISMATCH);
  if (wallet.currency !== tx.money.currency) return rejected(tx, FailureCode.CURRENCY_MISMATCH);

  let reference: WagerTransaction | undefined;

  if (tx.usesReference()) {
    const found = await transactions.findByProviderAndExternalId(tx.providerId, tx.referenceExternalTransactionId!);
    if (!found) return pending(tx);

    const evaluation = tx.evaluateReference(found);
    if (evaluation.outcome === 'PENDING') return pending(tx);
    if (evaluation.outcome === 'INVALID') return rejected(tx, evaluation.failureCode);

    if (tx.isReversal() && (await transactions.existsProcessedReversal(found.id, tx.kind))) {
      return rejected(tx, FailureCode.REFERENCE_ALREADY_REVERSED);
    }

    tx.linkReference(found);
    reference = found;
  }

  if (!tx.affectsBalance()) {
    tx.markProcessed();
    return { events: [WagerTransactionProcessed.from(tx)] };
  }

  const direction = tx.ledgerDirectionFor(reference);

  if (direction === LedgerDirection.DEBIT && !wallet.canDebit(tx.money)) {
    return rejected(
      tx,
      tx.isReversal() ? FailureCode.REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE : FailureCode.INSUFFICIENT_BALANCE,
    );
  }

  const ledgerEntry =
    direction === LedgerDirection.DEBIT ? wallet.debit(tx.money, tx.id) : wallet.credit(tx.money, tx.id);
  tx.markProcessed();

  return {
    ledgerEntry,
    events: [WagerTransactionProcessed.from(tx), WalletBalanceChanged.from(wallet, ledgerEntry)],
  };
}
