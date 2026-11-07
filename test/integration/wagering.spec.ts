import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'crypto';
import { createTestDatabase, TestDatabase } from './support/test-database';
import { balanceOf, command, ledgerOf, newWallet, outboxOf, PROVIDER, walletsOutOfBalance } from './support/fixtures';
import {
  IdempotencyConflictError,
  InvalidPayloadError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../src/application/errors';
import { ProcessWagerTransactionUseCase } from '../../src/application/use-cases/process-wager-transaction.use-case';
import { TransactionalRepositories, UnitOfWork } from '../../src/application/ports/unit-of-work.port';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase('wagering');
});

afterAll(async () => {
  // Invariante final de TODOS os testes: saldo materializado == saldo reconstruído pelo ledger
  try {
    if (db) expect(await walletsOutOfBalance(db)).toEqual([]);
  } finally {
    await db?.destroy();
  }
});

const process = (cmd: Parameters<ProcessWagerTransactionUseCase['execute']>[0]) => db.processTransaction.execute(cmd);
const eventTypes = async (walletId: string) => (await outboxOf(db, walletId)).map((e) => e.event_type);

describe('OpenWalletUseCase', () => {
  it('saldo inicial > 0 gera OPENING + CREDIT + eventos na mesma transação', async () => {
    const w = await newWallet(db, '100.00');

    expect(w.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(w.version).toBe(2);
    expect(await balanceOf(db, w.id)).toBe('100.00');

    const ledger = await ledgerOf(db, w.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ direction: 'CREDIT', amount: '100.00' });

    const [opening] = await db.sql<{ kind: string; status: string; provider_id: string }>(
      `select kind, status, provider_id from wager_transactions where wallet_id = ?`,
      [w.id],
    );
    expect(opening).toEqual({ kind: 'OPENING', status: 'PROCESSED', provider_id: 'SYSTEM' });
    expect(await eventTypes(w.id)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  it('saldo inicial zero não gera transação, lançamento nem evento', async () => {
    const w = await newWallet(db, '0');
    expect(w.version).toBe(1);
    expect(await ledgerOf(db, w.id)).toHaveLength(0);
    expect(await outboxOf(db, w.id)).toHaveLength(0);
  });

  it('wallet duplicada (playerId + currency) é conflito; outra moeda é permitida', async () => {
    const playerId = randomUUID();
    await db.openWallet.execute({ playerId, initialBalance: { amount: '10.00', currency: 'BRL' } });
    await expect(db.openWallet.execute({ playerId, initialBalance: { amount: '5.00', currency: 'BRL' } })).rejects.toBeInstanceOf(
      WalletAlreadyExistsError,
    );
    const usd = await db.openWallet.execute({ playerId, initialBalance: { amount: '5.00', currency: 'USD' } });
    expect(usd.balance.currency).toBe('USD');
  });

  it('payload inválido', async () => {
    await expect(db.openWallet.execute({ playerId: 'x', initialBalance: { amount: '1', currency: 'BRL' } })).rejects.toBeInstanceOf(
      InvalidPayloadError,
    );
    await expect(
      db.openWallet.execute({ playerId: randomUUID(), initialBalance: { amount: '-1', currency: 'BRL' } }),
    ).rejects.toBeInstanceOf(InvalidPayloadError);
  });
});

describe('BET', () => {
  it('debita, gera lançamento DEBIT e eventos Processed + BalanceChanged', async () => {
    const w = await newWallet(db);
    const r = await process(command(w, 'BET', '30.00'));

    expect(r.idempotentReplay).toBe(false);
    expect(r.transaction).toMatchObject({ kind: 'BET', status: 'PROCESSED', failureCode: null });
    expect(await balanceOf(db, w.id)).toBe('70.00');
    expect((await ledgerOf(db, w.id))[1]).toMatchObject({ direction: 'DEBIT', amount: '30.00', transaction_id: r.transaction.id });
    expect((await eventTypes(w.id)).slice(2)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  it('saldo insuficiente → REJECTED INSUFFICIENT_BALANCE, sem lançamento', async () => {
    const w = await newWallet(db);
    const r = await process(command(w, 'BET', '100.01'));

    expect(r.transaction).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_BALANCE' });
    expect(await balanceOf(db, w.id)).toBe('100.00');
    expect(await ledgerOf(db, w.id)).toHaveLength(1);
    expect((await eventTypes(w.id)).slice(2)).toEqual(['WagerTransactionRejected']);
  });

  it('pode zerar o saldo', async () => {
    const w = await newWallet(db);
    await process(command(w, 'BET', '100.00'));
    expect(await balanceOf(db, w.id)).toBe('0.00');
  });
});

describe('WIN', () => {
  it('credita sem referência', async () => {
    const w = await newWallet(db);
    const r = await process(command(w, 'WIN', '55.50'));
    expect(r.transaction.status).toBe('PROCESSED');
    expect(await balanceOf(db, w.id)).toBe('155.50');
  });

  it('com referência ao BET da mesma rodada vincula a referência', async () => {
    const w = await newWallet(db);
    const bet = await process(command(w, 'BET', '10.00'));
    const win = await process(
      command(w, 'WIN', '25.00', { referenceExternalTransactionId: bet.transaction.externalTransactionId }),
    );
    expect(win.transaction).toMatchObject({ status: 'PROCESSED', referenceTransactionId: bet.transaction.id });
    expect(await balanceOf(db, w.id)).toBe('115.00');
  });

  it('com referência ainda não recebida → PENDING_REFERENCE', async () => {
    const w = await newWallet(db);
    const r = await process(command(w, 'WIN', '25.00', { referenceExternalTransactionId: 'ainda-nao-chegou' }));
    expect(r.transaction.status).toBe('PENDING_REFERENCE');
    expect(await balanceOf(db, w.id)).toBe('100.00');
  });
});

describe('LOSS', () => {
  it('registra resultado sem mover saldo nem gerar lançamento; emite só Processed', async () => {
    const w = await newWallet(db);
    const r = await process(command(w, 'LOSS', '0'));
    expect(r.transaction).toMatchObject({ kind: 'LOSS', status: 'PROCESSED' });
    expect(await balanceOf(db, w.id)).toBe('100.00');
    expect(await ledgerOf(db, w.id)).toHaveLength(1);
    expect((await eventTypes(w.id)).slice(2)).toEqual(['WagerTransactionProcessed']);
  });
});

describe('REFUND', () => {
  it('credita o valor do BET e não permite segundo REFUND do mesmo BET', async () => {
    const w = await newWallet(db);
    const bet = await process(command(w, 'BET', '40.00'));
    const ref = bet.transaction.externalTransactionId;

    const refund = await process(command(w, 'REFUND', '40.00', { referenceExternalTransactionId: ref }));
    expect(refund.transaction).toMatchObject({ status: 'PROCESSED', referenceTransactionId: bet.transaction.id });
    expect(await balanceOf(db, w.id)).toBe('100.00');

    const again = await process(command(w, 'REFUND', '40.00', { referenceExternalTransactionId: ref }));
    expect(again.transaction).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_ALREADY_REVERSED' });
    expect(await balanceOf(db, w.id)).toBe('100.00');
  });

  it('só referencia BET', async () => {
    const w = await newWallet(db);
    const win = await process(command(w, 'WIN', '10.00'));
    const r = await process(
      command(w, 'REFUND', '10.00', { referenceExternalTransactionId: win.transaction.externalTransactionId }),
    );
    expect(r.transaction).toMatchObject({ status: 'REJECTED', failureCode: 'INVALID_REFERENCE_KIND' });
  });

  it('valor diferente da referência → REFERENCE_AMOUNT_MISMATCH', async () => {
    const w = await newWallet(db);
    const bet = await process(command(w, 'BET', '40.00'));
    const r = await process(
      command(w, 'REFUND', '20.00', { referenceExternalTransactionId: bet.transaction.externalTransactionId }),
    );
    expect(r.transaction).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_AMOUNT_MISMATCH' });
  });

  it('chegando antes do BET → PENDING_REFERENCE com evento, sem lançamento', async () => {
    const w = await newWallet(db);
    const r = await process(command(w, 'REFUND', '40.00', { referenceExternalTransactionId: 'bet-futuro' }));
    expect(r.transaction.status).toBe('PENDING_REFERENCE');
    expect(await ledgerOf(db, w.id)).toHaveLength(1);
    expect((await eventTypes(w.id)).slice(2)).toEqual(['WagerTransactionPendingReference']);
  });

  it('referência de outra rodada → REFERENCE_MISMATCH', async () => {
    const w = await newWallet(db);
    const bet = await process(command(w, 'BET', '10.00', { roundId: 'round-A' }));
    const r = await process(
      command(w, 'REFUND', '10.00', { roundId: 'round-B', referenceExternalTransactionId: bet.transaction.externalTransactionId }),
    );
    expect(r.transaction).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_MISMATCH' });
  });

  it('referência REJECTED → REFERENCE_NOT_PROCESSED', async () => {
    const w = await newWallet(db);
    const bet = await process(command(w, 'BET', '500.00'));
    expect(bet.transaction.status).toBe('REJECTED');
    const r = await process(
      command(w, 'REFUND', '500.00', { referenceExternalTransactionId: bet.transaction.externalTransactionId }),
    );
    expect(r.transaction).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_NOT_PROCESSED' });
  });
});

describe('ROLLBACK', () => {
  it('de BET credita (inverso)', async () => {
    const w = await newWallet(db);
    const bet = await process(command(w, 'BET', '30.00'));
    const r = await process(
      command(w, 'ROLLBACK', '30.00', { referenceExternalTransactionId: bet.transaction.externalTransactionId }),
    );
    expect(r.transaction.status).toBe('PROCESSED');
    expect(await balanceOf(db, w.id)).toBe('100.00');
    expect((await ledgerOf(db, w.id)).map((l) => l.direction)).toEqual(['CREDIT', 'DEBIT', 'CREDIT']);
  });

  it('de WIN debita (inverso); segundo ROLLBACK é rejeitado', async () => {
    const w = await newWallet(db);
    const win = await process(command(w, 'WIN', '50.00'));
    const ref = win.transaction.externalTransactionId;

    const r = await process(command(w, 'ROLLBACK', '50.00', { referenceExternalTransactionId: ref }));
    expect(r.transaction.status).toBe('PROCESSED');
    expect(await balanceOf(db, w.id)).toBe('100.00');

    const again = await process(command(w, 'ROLLBACK', '50.00', { referenceExternalTransactionId: ref }));
    expect(again.transaction).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_ALREADY_REVERSED' });
  });

  it('de WIN que deixaria saldo negativo → REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE', async () => {
    const w = await newWallet(db);
    const win = await process(command(w, 'WIN', '50.00'));
    await process(command(w, 'BET', '120.00'));
    expect(await balanceOf(db, w.id)).toBe('30.00');

    const r = await process(
      command(w, 'ROLLBACK', '50.00', { referenceExternalTransactionId: win.transaction.externalTransactionId }),
    );
    expect(r.transaction).toMatchObject({ status: 'REJECTED', failureCode: 'REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE' });
    expect(await balanceOf(db, w.id)).toBe('30.00');
  });

  it('de REFUND debita (desfaz o reembolso)', async () => {
    const w = await newWallet(db);
    const bet = await process(command(w, 'BET', '20.00'));
    const refund = await process(
      command(w, 'REFUND', '20.00', { referenceExternalTransactionId: bet.transaction.externalTransactionId }),
    );
    const r = await process(
      command(w, 'ROLLBACK', '20.00', { referenceExternalTransactionId: refund.transaction.externalTransactionId }),
    );
    expect(r.transaction.status).toBe('PROCESSED');
    expect(await balanceOf(db, w.id)).toBe('80.00');
  });

  it('de LOSS → INVALID_REFERENCE_KIND', async () => {
    const w = await newWallet(db);
    const loss = await process(command(w, 'LOSS', '0'));
    const r = await process(
      command(w, 'ROLLBACK', '0.01', { referenceExternalTransactionId: loss.transaction.externalTransactionId }),
    );
    expect(r.transaction).toMatchObject({ status: 'REJECTED', failureCode: 'INVALID_REFERENCE_KIND' });
  });
});

describe('Validações contra a wallet', () => {
  it('playerId diferente do dono → REJECTED PLAYER_MISMATCH (persistido)', async () => {
    const w = await newWallet(db);
    const r = await process(command({ id: w.id, playerId: randomUUID() }, 'BET', '1.00'));
    expect(r.transaction).toMatchObject({ status: 'REJECTED', failureCode: 'PLAYER_MISMATCH' });
  });

  it('moeda diferente da wallet → REJECTED CURRENCY_MISMATCH', async () => {
    const w = await newWallet(db);
    const r = await process(command(w, 'BET', '1.00', { currency: 'USD' }));
    expect(r.transaction).toMatchObject({ status: 'REJECTED', failureCode: 'CURRENCY_MISMATCH' });
    expect(await balanceOf(db, w.id)).toBe('100.00');
  });

  it('wallet inexistente → WalletNotFoundError e nada é persistido', async () => {
    const cmd = command({ id: randomUUID(), playerId: randomUUID() }, 'BET', '1.00');
    await expect(process(cmd)).rejects.toBeInstanceOf(WalletNotFoundError);
    expect(await db.sql(`select 1 from wager_transactions where idempotency_key = ?`, [cmd.idempotencyKey])).toHaveLength(0);
  });

  it('payload inválido: OPENING, valor zero, REFUND sem referência, UUID inválido', async () => {
    const w = await newWallet(db);
    for (const cmd of [
      command(w, 'OPENING', '1.00'),
      command(w, 'BET', '0.00'),
      command(w, 'REFUND', '1.00'),
      command(w, 'BET', '1.001'),
      command(w, 'BET', '1.00', { currency: 'brl' }),
      command({ id: 'nao-e-uuid', playerId: w.playerId }, 'BET', '1.00'),
      command(w, 'BET', '1.00', { idempotencyKey: '' }),
    ]) {
      await expect(process(cmd)).rejects.toBeInstanceOf(InvalidPayloadError);
    }
  });
});

describe('Idempotência', () => {
  it('replay idêntico devolve a mesma transação sem novo efeito', async () => {
    const w = await newWallet(db);
    const cmd = command(w, 'BET', '25.00');

    const first = await process(cmd);
    const second = await process(cmd);

    expect(second.idempotentReplay).toBe(true);
    expect(second.transaction.id).toBe(first.transaction.id);
    expect(await balanceOf(db, w.id)).toBe('75.00');
    expect(await ledgerOf(db, w.id)).toHaveLength(2);
    expect(await outboxOf(db, w.id)).toHaveLength(4);
  });

  it('"25" e "25.00" são o mesmo payload', async () => {
    const w = await newWallet(db);
    const cmd = command(w, 'BET', '25');
    await process(cmd);
    const again = await process({ ...cmd, amount: '25.00' });
    expect(again.idempotentReplay).toBe(true);
  });

  it('mesma chave com payload diferente → conflito, sem efeito', async () => {
    const w = await newWallet(db);
    const cmd = command(w, 'BET', '25.00');
    await process(cmd);
    await expect(process({ ...cmd, amount: '26.00' })).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await balanceOf(db, w.id)).toBe('75.00');
  });

  it('mesma transação externa com outra chave: payload igual é replay, diferente é conflito', async () => {
    const w = await newWallet(db);
    const cmd = command(w, 'BET', '10.00');
    const first = await process(cmd);

    const sameTx = await process({ ...cmd, idempotencyKey: `outra-chave-${randomUUID()}` });
    expect(sameTx).toMatchObject({ idempotentReplay: true, transaction: { id: first.transaction.id } });

    await expect(process({ ...cmd, idempotencyKey: `outra-${randomUUID()}`, amount: '11.00' })).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
  });

  it('replay de transação REJECTED devolve o mesmo resultado', async () => {
    const w = await newWallet(db);
    const cmd = command(w, 'BET', '999.00');
    await process(cmd);
    const again = await process(cmd);
    expect(again).toMatchObject({ idempotentReplay: true, transaction: { status: 'REJECTED', failureCode: 'INSUFFICIENT_BALANCE' } });
  });
});

describe('Inbox (entrada via SQS)', () => {
  it('registra a mensagem processada; redelivery da mesma mensagem é replay sem efeito', async () => {
    const w = await newWallet(db);
    const messageId = `msg-${randomUUID()}`;
    const cmd = { ...command(w, 'BET', '10.00'), inbox: { consumerName: 'wager-processor', messageId } };

    const first = await process(cmd);
    const redelivery = await process(cmd);

    expect(first.idempotentReplay).toBe(false);
    expect(redelivery.idempotentReplay).toBe(true);
    expect(await balanceOf(db, w.id)).toBe('90.00');

    const rows = await db.sql<{ processed_at: Date | null }>(
      `select processed_at from inbox_messages where consumer_name = ? and message_id = ?`,
      ['wager-processor', messageId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].processed_at).not.toBeNull();
  });

  it('mensagem nova com o mesmo payload é replay e também fica registrada', async () => {
    const w = await newWallet(db);
    const base = command(w, 'BET', '10.00');
    await process({ ...base, inbox: { consumerName: 'wager-processor', messageId: `a-${randomUUID()}` } });
    const second = `b-${randomUUID()}`;
    const r = await process({ ...base, inbox: { consumerName: 'wager-processor', messageId: second } });

    expect(r.idempotentReplay).toBe(true);
    expect(await db.sql(`select 1 from inbox_messages where message_id = ?`, [second])).toHaveLength(1);
    expect(await balanceOf(db, w.id)).toBe('90.00');
  });
});

describe('Atomicidade', () => {
  /** Unit of Work que falha ao gravar o outbox, depois de transação, ledger e saldo. */
  class FailingOutboxUnitOfWork implements UnitOfWork {
    constructor(private readonly inner: UnitOfWork) {}
    run<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T> {
      return this.inner.run((repos) =>
        work({
          ...repos,
          outbox: {
            insert: async () => {
              throw new Error('falha simulada ao gravar outbox');
            },
          },
        }),
      );
    }
  }

  it('falha no meio desfaz transação, ledger, saldo e inbox', async () => {
    const w = await newWallet(db);
    const failing = new ProcessWagerTransactionUseCase(new FailingOutboxUnitOfWork(new MikroOrmUnitOfWork(db.orm)));
    const messageId = `msg-${randomUUID()}`;
    const cmd = { ...command(w, 'BET', '10.00'), inbox: { consumerName: 'wager-processor', messageId } };

    await expect(failing.execute(cmd)).rejects.toThrow('falha simulada');

    expect(await balanceOf(db, w.id)).toBe('100.00');
    expect(await ledgerOf(db, w.id)).toHaveLength(1);
    expect(await db.sql(`select 1 from wager_transactions where idempotency_key = ?`, [cmd.idempotencyKey])).toHaveLength(0);
    expect(await db.sql(`select 1 from inbox_messages where message_id = ?`, [messageId])).toHaveLength(0);

    // A mesma mensagem reprocessada depois da falha é aplicada normalmente
    const ok = await process(cmd);
    expect(ok.idempotentReplay).toBe(false);
    expect(await balanceOf(db, w.id)).toBe('90.00');
  });
});

describe('Provedores distintos', () => {
  it('mesmo externalTransactionId em provedores diferentes são transações diferentes', async () => {
    const w = await newWallet(db);
    const a = await process(command(w, 'BET', '1.00', { externalTransactionId: 'shared-ext', idempotencyKey: `${PROVIDER}:shared-ext` }));
    const b = await process(
      command(w, 'BET', '1.00', { providerId: 'provider-b', externalTransactionId: 'shared-ext', idempotencyKey: 'provider-b:shared-ext' }),
    );
    expect(a.transaction.id).not.toBe(b.transaction.id);
    expect(await balanceOf(db, w.id)).toBe('98.00');
  });
});
