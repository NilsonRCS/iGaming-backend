import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createTestDatabase, TestDatabase } from './support/test-database';
import { balanceOf, command, ledgerOf, newWallet, outboxOf, walletsOutOfBalance } from './support/fixtures';

/**
 * Paralelismo real: cada chamada usa sua própria conexão e transação SQL no PostgreSQL.
 * Sem mocks; a serialização vem exclusivamente do SELECT ... FOR UPDATE na wallet.
 */
let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase('concurrency');
});

afterAll(async () => {
  try {
    if (db) expect(await walletsOutOfBalance(db)).toEqual([]);
  } finally {
    await db?.destroy();
  }
});

describe('Concorrência na mesma wallet', () => {
  it('duas apostas de 80.00 sobre saldo 100.00: exatamente uma passa', async () => {
    const w = await newWallet(db, '100.00');

    const results = await Promise.all([
      db.processTransaction.execute(command(w, 'BET', '80.00')),
      db.processTransaction.execute(command(w, 'BET', '80.00')),
    ]);

    const statuses = results.map((r) => r.transaction.status).sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
    expect(results.find((r) => r.transaction.status === 'REJECTED')!.transaction.failureCode).toBe('INSUFFICIENT_BALANCE');
    expect(await balanceOf(db, w.id)).toBe('20.00');

    const debits = (await ledgerOf(db, w.id)).filter((l) => l.direction === 'DEBIT');
    expect(debits).toHaveLength(1);
    expect(debits[0].amount).toBe('80.00');
  });

  it('mesma aposta enviada 50x em paralelo: um único débito', async () => {
    const w = await newWallet(db, '100.00');
    const cmd = command(w, 'BET', '10.00');

    const results = await Promise.all(Array.from({ length: 50 }, () => db.processTransaction.execute(cmd)));

    expect(new Set(results.map((r) => r.transaction.id)).size).toBe(1);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(await balanceOf(db, w.id)).toBe('90.00');
    expect((await ledgerOf(db, w.id)).filter((l) => l.direction === 'DEBIT')).toHaveLength(1);
    // OPENING (2 eventos) + BET (2 eventos); nenhum evento duplicado
    expect(await outboxOf(db, w.id)).toHaveLength(4);
  });

  it('20 apostas de 10.00 sobre saldo 100.00: exatamente 10 passam e o saldo zera', async () => {
    const w = await newWallet(db, '100.00');

    const results = await Promise.all(
      Array.from({ length: 20 }, () => db.processTransaction.execute(command(w, 'BET', '10.00'))),
    );

    expect(results.filter((r) => r.transaction.status === 'PROCESSED')).toHaveLength(10);
    expect(results.filter((r) => r.transaction.failureCode === 'INSUFFICIENT_BALANCE')).toHaveLength(10);
    expect(await balanceOf(db, w.id)).toBe('0.00');
  });

  it('mesma mensagem SQS entregue 20x em paralelo: um único efeito e um único registro de inbox', async () => {
    const w = await newWallet(db, '100.00');
    const cmd = { ...command(w, 'BET', '5.00'), inbox: { consumerName: 'wager-processor', messageId: `msg-${w.id}` } };

    const results = await Promise.all(Array.from({ length: 20 }, () => db.processTransaction.execute(cmd)));

    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(await balanceOf(db, w.id)).toBe('95.00');
    expect(await db.sql(`select 1 from inbox_messages where message_id = ?`, [cmd.inbox.messageId])).toHaveLength(1);
  });

  it('REFUND do mesmo BET enviado em paralelo com chaves diferentes: um único crédito', async () => {
    const w = await newWallet(db, '100.00');
    const bet = await db.processTransaction.execute(command(w, 'BET', '30.00'));
    const ref = bet.transaction.externalTransactionId;

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        db.processTransaction.execute(command(w, 'REFUND', '30.00', { referenceExternalTransactionId: ref })),
      ),
    );

    expect(results.filter((r) => r.transaction.status === 'PROCESSED')).toHaveLength(1);
    expect(results.filter((r) => r.transaction.failureCode === 'REFERENCE_ALREADY_REVERSED')).toHaveLength(9);
    expect(await balanceOf(db, w.id)).toBe('100.00');
  });
});

describe('Concorrência entre wallets', () => {
  it('wallets distintas processadas em paralelo sem interferência', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => newWallet(db, '50.00')));

    await Promise.all(
      wallets.flatMap((w) => [
        db.processTransaction.execute(command(w, 'BET', '20.00')),
        db.processTransaction.execute(command(w, 'BET', '20.00')),
        db.processTransaction.execute(command(w, 'WIN', '5.00')),
      ]),
    );

    for (const w of wallets) {
      expect(await balanceOf(db, w.id)).toBe('15.00');
    }
  });

  it('criação concorrente da mesma wallet: uma cria, as demais recebem conflito', async () => {
    const playerId = crypto.randomUUID();
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => db.openWallet.execute({ playerId, initialBalance: { amount: '10.00', currency: 'BRL' } })),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(9);
    for (const r of rejected) expect(r.reason.constructor.name).toBe('WalletAlreadyExistsError');
    expect(await db.sql(`select 1 from wallets where player_id = ?`, [playerId])).toHaveLength(1);
  });
});
