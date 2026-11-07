import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createTestDatabase, TestDatabase } from './support/test-database';
import { balanceOf, command, ledgerOf, newWallet, outboxOf, walletsOutOfBalance } from './support/fixtures';
import { sleep } from './support/test-queues';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { ResolvePendingReferencesUseCase } from '../../src/application/use-cases/resolve-pending-references.use-case';
import { PendingReferencePolicy } from '../../src/domain/wager-transaction/pending-reference-policy';

/** Seção 7.4 com PostgreSQL real: o worker resolve, reagenda e expira transações PENDING_REFERENCE. */
let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase('pending_ref');
});

afterAll(async () => {
  try {
    if (db) expect(await walletsOutOfBalance(db)).toEqual([]);
  } finally {
    await db?.destroy();
  }
});

/** Política curta para teste: base 200ms, teto 400ms, TTL longo salvo indicação. */
function resolver(policy = new PendingReferencePolicy(200, 400, 60_000)) {
  return new ResolvePendingReferencesUseCase(new MikroOrmUnitOfWork(db.orm), policy);
}

const process = (cmd: Parameters<TestDatabase['processTransaction']['execute']>[0]) => db.processTransaction.execute(cmd);

const row = async (externalId: string) =>
  (
    await db.sql<{
      id: string;
      status: string;
      failure_code: string | null;
      reference_transaction_id: string | null;
      reference_attempts: number;
      next_in_ms: number | null;
      processed_at: Date | null;
    }>(
      `select id, status, failure_code, reference_transaction_id, reference_attempts, processed_at,
              (extract(epoch from next_reference_attempt_at - now()) * 1000)::int as next_in_ms
         from wager_transactions where external_transaction_id = ?`,
      [externalId],
    )
  )[0];

/** Resolve até não haver candidatas devidas (cada chamada é um ciclo do worker). */
async function drain(r = resolver()) {
  for (let i = 0; i < 10; i++) if ((await r.execute(50)).candidates === 0) return;
}

describe('Resolução quando a referência chega', () => {
  it('REFUND antes do BET: fica pendente sem crédito; o worker aplica quando o BET chega', async () => {
    const w = await newWallet(db, '100.00');
    const bet = command(w, 'BET', '30.00');
    const refund = command(w, 'REFUND', '30.00', { referenceExternalTransactionId: bet.externalTransactionId });

    expect((await process(refund)).transaction.status).toBe('PENDING_REFERENCE');
    expect(await balanceOf(db, w.id)).toBe('100.00');

    // Referência ainda ausente: continua pendente, conta a tentativa
    const first = await resolver().execute(50);
    expect(first).toMatchObject({ stillPending: 1, processed: 0 });

    await process(bet);
    await sleep(250); // backoff da 1ª tentativa
    const r = await resolver().execute(50);
    expect(r).toMatchObject({ processed: 1 });

    const refundRow = await row(refund.externalTransactionId);
    const betRow = await row(bet.externalTransactionId);
    expect(refundRow).toMatchObject({ status: 'PROCESSED', reference_transaction_id: betRow.id, failure_code: null });
    expect(refundRow.processed_at).not.toBeNull();
    expect(await balanceOf(db, w.id)).toBe('100.00');
    expect((await ledgerOf(db, w.id)).map((l) => `${l.direction} ${l.amount}`)).toEqual(['CREDIT 100.00', 'DEBIT 30.00', 'CREDIT 30.00']);

    const events = (await outboxOf(db, w.id)).filter((e) => (e.payload.payload as any).transactionId === refundRow.id).map((e) => e.event_type);
    // Pendente ao entrar; na resolução, processada + saldo alterado (sem repetir PendingReference a cada tentativa)
    expect(events).toEqual(['WagerTransactionPendingReference', 'WagerTransactionProcessed', 'WalletBalanceChanged']);

    // Já resolvida: nada mais a fazer
    expect((await resolver().execute(50)).candidates).toBe(0);
  });

  it('replay da REFUND depois da resolução devolve o estado atual (PROCESSED)', async () => {
    const w = await newWallet(db, '100.00');
    const bet = command(w, 'BET', '10.00');
    const refund = command(w, 'REFUND', '10.00', { referenceExternalTransactionId: bet.externalTransactionId });
    await process(refund);
    await process(bet);
    await drain();
    const replay = await process(refund);
    expect(replay).toMatchObject({ idempotentReplay: true, transaction: { status: 'PROCESSED' } });
  });

  it('cadeia ROLLBACK → REFUND → BET se resolve sozinha em ciclos sucessivos', async () => {
    const w = await newWallet(db, '100.00');
    const bet = command(w, 'BET', '30.00');
    const refund = command(w, 'REFUND', '30.00', { referenceExternalTransactionId: bet.externalTransactionId });
    const rollback = command(w, 'ROLLBACK', '30.00', { referenceExternalTransactionId: refund.externalTransactionId });

    await process(rollback);
    await process(refund);
    await process(bet);

    const r = resolver();
    await r.execute(50); // REFUND resolve; ROLLBACK ainda vê a REFUND pendente
    expect((await row(refund.externalTransactionId)).status).toBe('PROCESSED');
    expect((await row(rollback.externalTransactionId)).status).toBe('PENDING_REFERENCE');

    await sleep(250);
    await r.execute(50);
    expect((await row(rollback.externalTransactionId)).status).toBe('PROCESSED');
    // BET debita, REFUND devolve, ROLLBACK da REFUND debita de novo
    expect(await balanceOf(db, w.id)).toBe('70.00');
    expect((await ledgerOf(db, w.id)).map((l) => l.direction)).toEqual(['CREDIT', 'DEBIT', 'CREDIT', 'DEBIT']);
  });
});

describe('Backoff e expiração (seção 7.4)', () => {
  it('cada tentativa sem referência conta e agenda a próxima com backoff exponencial (relógio do banco)', async () => {
    const w = await newWallet(db, '100.00');
    const refund = command(w, 'REFUND', '5.00', { referenceExternalTransactionId: 'never-arrives-1' });
    await process(refund);
    expect(await row(refund.externalTransactionId)).toMatchObject({ reference_attempts: 0, next_in_ms: null });

    const r = resolver(new PendingReferencePolicy(400, 10_000, 60_000));
    await r.execute(50);
    let s = await row(refund.externalTransactionId);
    expect(s.reference_attempts).toBe(1);
    expect(s.next_in_ms).toBeGreaterThan(250);
    expect(s.next_in_ms).toBeLessThanOrEqual(400);

    // Antes da hora não é reprocessada
    await r.execute(50);
    expect((await row(refund.externalTransactionId)).reference_attempts).toBe(1);

    await sleep(450);
    await r.execute(50);
    s = await row(refund.externalTransactionId);
    expect(s.reference_attempts).toBe(2);
    expect(s.next_in_ms).toBeGreaterThan(650); // 2ª espera = 2 × base
    expect(s.next_in_ms).toBeLessThanOrEqual(800);
  });

  it('TTL esgotado: REJECTED com REFERENCE_NOT_FOUND e evento WagerTransactionRejected no outbox', async () => {
    const w = await newWallet(db, '100.00');
    const refund = command(w, 'REFUND', '5.00', { referenceExternalTransactionId: 'never-arrives-2' });
    await process(refund);

    // Backoff maior que o TTL: o agendamento é limitado ao vencimento
    const r = resolver(new PendingReferencePolicy(5_000, 10_000, 600));
    await r.execute(50);
    const s = await row(refund.externalTransactionId);
    expect(s.status).toBe('PENDING_REFERENCE');
    expect(s.next_in_ms).toBeLessThanOrEqual(600);

    await sleep(650);
    const result = await r.execute(50);
    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect(await row(refund.externalTransactionId)).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND' });
    expect(await balanceOf(db, w.id)).toBe('100.00');

    const rejected = (await outboxOf(db, w.id)).find(
      (e) => e.event_type === 'WagerTransactionRejected' && (e.payload.payload as any).transactionId === s.id,
    );
    expect(rejected).toBeDefined();
    expect((rejected!.payload.payload as any).failureCode).toBe('REFERENCE_NOT_FOUND');
  });
});

describe('Regras da seção 7.2 aplicadas na resolução', () => {
  it('referência que chega com tipo inválido (REFUND de um WIN) → INVALID_REFERENCE_KIND', async () => {
    const w = await newWallet(db, '100.00');
    const win = command(w, 'WIN', '20.00');
    const refund = command(w, 'REFUND', '20.00', { referenceExternalTransactionId: win.externalTransactionId });
    await process(refund);
    await process(win);
    await drain();
    expect(await row(refund.externalTransactionId)).toMatchObject({ status: 'REJECTED', failure_code: 'INVALID_REFERENCE_KIND' });
    const events = (await outboxOf(db, w.id)).map((e) => e.event_type);
    expect(events).toContain('WagerTransactionRejected');
  });

  it('referência que chega rejeitada → REFERENCE_NOT_PROCESSED', async () => {
    const w = await newWallet(db, '10.00');
    const bet = command(w, 'BET', '50.00'); // saldo insuficiente → REJECTED
    const refund = command(w, 'REFUND', '50.00', { referenceExternalTransactionId: bet.externalTransactionId });
    await process(refund);
    await process(bet);
    await drain();
    expect(await row(refund.externalTransactionId)).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_PROCESSED' });
    expect(await balanceOf(db, w.id)).toBe('10.00');
  });

  it('duas REFUNDs pendentes do mesmo BET: uma aplica, a outra REFERENCE_ALREADY_REVERSED', async () => {
    const w = await newWallet(db, '100.00');
    const bet = command(w, 'BET', '40.00');
    const r1 = command(w, 'REFUND', '40.00', { referenceExternalTransactionId: bet.externalTransactionId });
    const r2 = command(w, 'REFUND', '40.00', { referenceExternalTransactionId: bet.externalTransactionId });
    await process(r1);
    await process(r2);
    await process(bet);
    await drain();

    const statuses = [await row(r1.externalTransactionId), await row(r2.externalTransactionId)];
    expect(statuses.map((s) => s.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect(statuses.find((s) => s.status === 'REJECTED')!.failure_code).toBe('REFERENCE_ALREADY_REVERSED');
    expect((await ledgerOf(db, w.id)).filter((l) => l.direction === 'CREDIT')).toHaveLength(2); // abertura + 1 reembolso
    expect(await balanceOf(db, w.id)).toBe('100.00');
  });

  it('ROLLBACK de WIN que deixaria o saldo negativo → REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE', async () => {
    const w = await newWallet(db, '100.00');
    const win = command(w, 'WIN', '50.00');
    const rollback = command(w, 'ROLLBACK', '50.00', { referenceExternalTransactionId: win.externalTransactionId });
    await process(rollback);
    await process(win);
    await process(command(w, 'BET', '140.00')); // gasta o prêmio: saldo 10.00
    await drain();
    expect(await row(rollback.externalTransactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE',
    });
    expect(await balanceOf(db, w.id)).toBe('10.00');
  });
});

describe('Concorrência', () => {
  it('3 workers + chegada das referências em paralelo: cada reversão aplicada uma única vez, sem deadlock', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => newWallet(db, '100.00')));
    const plans = wallets.map((w) => {
      const bets = [command(w, 'BET', '10.00'), command(w, 'BET', '15.00')];
      const refunds = bets.map((b) => command(w, 'REFUND', b.amount, { referenceExternalTransactionId: b.externalTransactionId }));
      return { w, bets, refunds };
    });
    for (const p of plans) for (const r of p.refunds) await process(r);

    const workers = [resolver(), resolver(), resolver()];
    const errors: unknown[] = [];
    let stop = false;
    const loops = workers.map(async (r) => {
      while (!stop) {
        const res = await r.execute(7);
        if (res.firstError) errors.push(res.firstError);
        await sleep(20);
      }
    });

    // Referências chegam enquanto os workers rodam (mesmas wallets → disputa pelo lock)
    await Promise.all(plans.flatMap((p) => p.bets.map((b) => process(b))));
    // Duplicatas das REFUNDs chegando de novo ao mesmo tempo (replay)
    await Promise.all(plans.flatMap((p) => p.refunds.map((r) => process(r))));

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const [{ n }] = await db.sql<{ n: number }>(
        `select count(*)::int as n from wager_transactions where status = 'PENDING_REFERENCE' and wallet_id in (${wallets.map(() => '?').join(',')})`,
        wallets.map((w) => w.id),
      );
      if (n === 0) break;
      await sleep(100);
    }
    stop = true;
    await Promise.all(loops);

    expect(errors).toEqual([]);
    for (const p of plans) {
      for (const r of p.refunds) expect((await row(r.externalTransactionId)).status).toBe('PROCESSED');
      expect(await balanceOf(db, p.w.id)).toBe('100.00');
      const ledger = await ledgerOf(db, p.w.id);
      expect(ledger.filter((l) => l.direction === 'CREDIT')).toHaveLength(3); // abertura + 2 reembolsos
      expect(new Set(ledger.map((l) => l.transaction_id)).size).toBe(ledger.length);
    }
  }, 30_000);
});
