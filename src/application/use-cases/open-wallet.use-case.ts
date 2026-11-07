import { Money } from '../../shared/money/money';
import { Wallet } from '../../domain/wallet/wallet';
import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { WalletBalanceChanged } from '../../domain/wallet/wallet.events';
import { WagerTransaction } from '../../domain/wager-transaction/wager-transaction';
import { WagerKind } from '../../domain/wager-transaction/wager-transaction.enums';
import { WagerTransactionProcessed } from '../../domain/wager-transaction/wager-transaction.events';
import { IntegrationEvent } from '../../domain/shared/events/integration-event';
import { OutboxMessage } from '../../domain/shared/messaging/outbox-message';
import { UnitOfWork } from '../ports/unit-of-work.port';
import { InvalidPayloadError, UniqueViolationError, WalletAlreadyExistsError } from '../errors';
import { payloadHash } from '../idempotency/payload-hash';
import { Issues } from '../validation';
import { toWalletView, WalletView } from '../views';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: { amount: string; currency: string };
}

const MAX_ATTEMPTS = 2;

/**
 * Cria a wallet. Saldo inicial > 0 gera transação OPENING + lançamento CREDIT
 * na mesma transação SQL; o saldo nunca existe sem lançamento correspondente.
 */
export class OpenWalletUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(command: OpenWalletCommand): Promise<WalletView> {
    const issues = new Issues();
    issues.requireUuid('playerId', command.playerId);
    const initial = issues.parseMoney(command.initialBalance?.amount, command.initialBalance?.currency);
    if (!issues.empty || !initial) throw new InvalidPayloadError(issues.list);

    const playerId = command.playerId.toLowerCase();

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.uow.run(async (repos) => {
          if (await repos.wallets.findByPlayerAndCurrency(playerId, initial.currency)) {
            throw new WalletAlreadyExistsError(playerId, initial.currency);
          }

          const wallet = Wallet.open({ playerId, initialBalance: Money.zero(initial.currency) });
          const events: IntegrationEvent[] = [];
          let opening: WagerTransaction | undefined;
          let entry: WalletLedgerEntry | undefined;

          if (initial.isPositive()) {
            opening = WagerTransaction.opening({
              walletId: wallet.id,
              playerId,
              money: initial,
              payloadHash: payloadHash({
                kind: WagerKind.OPENING,
                walletId: wallet.id,
                playerId,
                amount: initial.amount,
                currency: initial.currency,
              }),
            });
            entry = wallet.credit(initial, opening.id);
            opening.markProcessed();
            events.push(WagerTransactionProcessed.from(opening), WalletBalanceChanged.from(wallet, entry));
          }

          await repos.wallets.insert(wallet);
          if (opening && entry) {
            await repos.transactions.insert(opening);
            await repos.ledger.insert(entry);
          }
          for (const event of events) {
            await repos.outbox.insert(OutboxMessage.enqueue(event));
          }

          return toWalletView(wallet);
        });
      } catch (e) {
        // Corrida: outra instância criou a mesma wallet entre a leitura e o INSERT
        if (e instanceof UniqueViolationError && attempt < MAX_ATTEMPTS) continue;
        throw e;
      }
    }
  }
}
