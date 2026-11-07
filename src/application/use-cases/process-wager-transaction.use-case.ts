import { Money } from '../../shared/money/money';
import { WagerTransaction } from '../../domain/wager-transaction/wager-transaction';
import { WagerKind } from '../../domain/wager-transaction/wager-transaction.enums';
import { OutboxMessage } from '../../domain/shared/messaging/outbox-message';
import { InboxMessage } from '../../domain/shared/messaging/inbox-message';
import { TransactionalRepositories, UnitOfWork } from '../ports/unit-of-work.port';
import { IdempotencyConflictError, InvalidPayloadError, UniqueViolationError, WalletNotFoundError } from '../errors';
import { payloadHash } from '../idempotency/payload-hash';
import { Issues } from '../validation';
import { toTransactionView, WagerTransactionView } from '../views';
import { applyWagerTransaction } from './apply-wager-transaction';

export interface ProcessWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId?: string | null;
  /** Presente quando a entrada vem do SQS: registra o inbox na mesma transação SQL. */
  inbox?: { consumerName: string; messageId: string };
}

export interface ProcessWagerTransactionResult {
  idempotentReplay: boolean;
  transaction: WagerTransactionView;
}

const SUBMITTABLE_KINDS = new Set<string>([
  WagerKind.BET,
  WagerKind.WIN,
  WagerKind.LOSS,
  WagerKind.REFUND,
  WagerKind.ROLLBACK,
]);

/** Corridas entre instâncias terminam em UNIQUE violada; a nova tentativa enxerga a linha vencedora. */
const MAX_ATTEMPTS = 3;

interface ValidInput {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerKind;
  money: Money;
  referenceExternalTransactionId?: string;
  payloadHash: string;
  inbox?: { consumerName: string; messageId: string };
}

/**
 * Caso de uso único para BET, WIN, LOSS, REFUND e ROLLBACK.
 * Usado igualmente pela API HTTP e pelo consumidor SQS.
 */
export class ProcessWagerTransactionUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(command: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult> {
    const input = this.validate(command);

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.uow.run((repos) => this.handle(repos, input));
      } catch (e) {
        if (e instanceof UniqueViolationError && attempt < MAX_ATTEMPTS) continue;
        throw e;
      }
    }
  }

  private async handle(repos: TransactionalRepositories, input: ValidInput): Promise<ProcessWagerTransactionResult> {
    // 1. Mensagem SQS já processada → replay sem tocar na wallet
    if (input.inbox) {
      const seen = await repos.inbox.find(input.inbox.consumerName, input.inbox.messageId);
      if (seen) {
        const done = await this.findExisting(repos, input);
        if (done) return this.replay(done, input);
      }
    }

    // 2. Lock da wallet: serializa todas as operações desta wallet entre instâncias
    const wallet = await repos.wallets.findByIdForUpdate(input.walletId);
    if (!wallet) throw new WalletNotFoundError(input.walletId);

    // 3. Idempotência persistente (verificada sob o lock)
    const existing = await this.findExisting(repos, input);
    if (existing) {
      await this.recordInbox(repos, input);
      return this.replay(existing, input);
    }

    // 4. Regras de negócio
    const tx = WagerTransaction.create({
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash: input.payloadHash,
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money: input.money,
      referenceExternalTransactionId: input.referenceExternalTransactionId,
    });
    const outcome = await applyWagerTransaction(repos.transactions, tx, wallet);

    // 5. Persistência atômica: transação, ledger, saldo, outbox e inbox no mesmo COMMIT
    await repos.transactions.insert(tx);
    if (outcome.ledgerEntry) {
      await repos.ledger.insert(outcome.ledgerEntry);
      await repos.wallets.update(wallet);
    }
    for (const event of outcome.events) {
      await repos.outbox.insert(OutboxMessage.enqueue(event));
    }
    await this.recordInbox(repos, input);

    return { idempotentReplay: false, transaction: toTransactionView(tx) };
  }

  private async findExisting(repos: TransactionalRepositories, input: ValidInput): Promise<WagerTransaction | null> {
    return (
      (await repos.transactions.findByIdempotencyKey(input.idempotencyKey)) ??
      (await repos.transactions.findByProviderAndExternalId(input.providerId, input.externalTransactionId))
    );
  }

  private replay(existing: WagerTransaction, input: ValidInput): ProcessWagerTransactionResult {
    if (!existing.matchesPayload(input.payloadHash)) {
      throw new IdempotencyConflictError(input.idempotencyKey, existing.id);
    }
    return { idempotentReplay: true, transaction: toTransactionView(existing) };
  }

  private async recordInbox(repos: TransactionalRepositories, input: ValidInput): Promise<void> {
    if (!input.inbox) return;
    if (await repos.inbox.find(input.inbox.consumerName, input.inbox.messageId)) return;
    const message = InboxMessage.receive({ ...input.inbox, payloadHash: input.payloadHash });
    message.markProcessed(new Date());
    await repos.inbox.insert(message);
  }

  private validate(c: ProcessWagerTransactionCommand): ValidInput {
    const issues = new Issues();

    issues.requireString('idempotencyKey', c.idempotencyKey);
    issues.requireString('providerId', c.providerId);
    issues.requireString('externalTransactionId', c.externalTransactionId);
    issues.requireUuid('walletId', c.walletId);
    issues.requireUuid('playerId', c.playerId);
    issues.requireString('roundId', c.roundId);
    issues.requireString('gameId', c.gameId);

    if (issues.requireString('kind', c.kind) && !SUBMITTABLE_KINDS.has(c.kind)) {
      issues.add(`kind must be one of ${[...SUBMITTABLE_KINDS].join(', ')}`);
    }
    const kind = c.kind as WagerKind;

    const money = issues.parseMoney(c.amount, c.currency);
    if (money && money.isZero() && kind !== WagerKind.LOSS) {
      issues.add('amount must be greater than zero');
    }

    const reference = c.referenceExternalTransactionId ?? undefined;
    if ((kind === WagerKind.REFUND || kind === WagerKind.ROLLBACK) && !reference) {
      issues.add(`referenceExternalTransactionId is required for ${kind}`);
    }
    if (reference !== undefined && (typeof reference !== 'string' || reference.trim() === '')) {
      issues.add('referenceExternalTransactionId must be a non-empty string');
    }

    if (c.inbox) {
      issues.requireString('inbox.consumerName', c.inbox.consumerName);
      issues.requireString('inbox.messageId', c.inbox.messageId);
    }

    if (!issues.empty || !money) throw new InvalidPayloadError(issues.list);

    return {
      idempotencyKey: c.idempotencyKey,
      providerId: c.providerId,
      externalTransactionId: c.externalTransactionId,
      walletId: c.walletId.toLowerCase(),
      playerId: c.playerId.toLowerCase(),
      roundId: c.roundId,
      gameId: c.gameId,
      kind,
      money,
      referenceExternalTransactionId: reference,
      inbox: c.inbox,
      payloadHash: payloadHash({
        providerId: c.providerId,
        externalTransactionId: c.externalTransactionId,
        walletId: c.walletId.toLowerCase(),
        playerId: c.playerId.toLowerCase(),
        roundId: c.roundId,
        gameId: c.gameId,
        kind,
        amount: money.amount,
        currency: money.currency,
        referenceExternalTransactionId: reference ?? null,
      }),
    };
  }
}
