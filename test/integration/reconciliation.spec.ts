import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'crypto';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestDatabase, TestDatabase } from './support/test-database';
import { createHttpApp } from './support/http-app';
import { balanceOf, command, newWallet, walletsOutOfBalance } from './support/fixtures';

/** Seção 9.4 pela API real (Nest + Fastify) sobre PostgreSQL real. */
let db: TestDatabase;
let app: NestFastifyApplication;

beforeAll(async () => {
  db = await createTestDatabase('reconciliation');
  app = await createHttpApp(db);
});

afterAll(async () => {
  try {
    if (db) expect(await walletsOutOfBalance(db)).toEqual([]);
  } finally {
    await app?.close();
    await db?.destroy();
  }
});

async function reconcile(walletId: string) {
  const r = await app.inject({ method: 'POST', url: `/wallets/${walletId}/reconciliation` });
  return { status: r.statusCode, body: JSON.parse(r.body) };
}

const metric = async (result: string) => {
  const text = (await app.inject({ method: 'GET', url: '/metrics' })).body;
  const line = text.split('\n').find((l) => l.startsWith(`wallet_reconciliations_total{result="${result}"}`));
  return line ? Number(line.split(' ').pop()) : 0;
};

/** Corrompe o saldo materializado (o ledger é imutável no schema; a wallet não). */
const corrupt = (walletId: string, delta: string) =>
  db.sql(`update wallets set balance_amount = balance_amount + ?::numeric where id = ?`, [delta, walletId]);

describe('POST /wallets/:walletId/reconciliation', () => {
  it('após tráfego misto: consistente, com o mesmo saldo da consulta e a contagem de lançamentos', async () => {
    const w = await newWallet(db, '100.00');
    const bet = command(w, 'BET', '30.00');
    await db.processTransaction.execute(bet);
    await db.processTransaction.execute(command(w, 'WIN', '45.50', { referenceExternalTransactionId: bet.externalTransactionId }));
    await db.processTransaction.execute(command(w, 'LOSS', '0'));
    await db.processTransaction.execute(command(w, 'BET', '500.00')); // rejeitada: sem lançamento

    const r = await reconcile(w.id);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      walletId: w.id,
      consistent: true,
      storedBalance: { amount: '115.50', currency: 'BRL' },
      ledgerBalance: { amount: '115.50', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      ledgerEntries: 3,
      walletVersion: 4,
    });
    expect(Number.isNaN(Date.parse(r.body.checkedAt))).toBe(false);
  });

  it('wallet aberta com saldo zero: sem lançamentos, consistente', async () => {
    const w = await newWallet(db, '0');
    expect((await reconcile(w.id)).body).toMatchObject({ consistent: true, ledgerEntries: 0, ledgerBalance: { amount: '0.00' } });
  });

  it.each([
    ['saldo acima do ledger', '0.01', '0.01'],
    ['saldo abaixo do ledger', '-0.01', '-0.01'],
    ['diferença com 4 casas', '0.0050', '0.005'],
  ])('divergência (%s): sinalizada na resposta e na métrica, nunca corrigida', async (_, delta, expected) => {
    const w = await newWallet(db, '100.00');
    await db.processTransaction.execute(command(w, 'BET', '10.00'));
    const before = await metric('divergent');
    await corrupt(w.id, delta);
    const storedBefore = await db.sql<{ v: number; b: string }>(`select version as v, balance_amount::text as b from wallets where id = ?`, [w.id]);

    try {
      const r = await reconcile(w.id);
      expect(r.status).toBe(200);
      expect(r.body.consistent).toBe(false);
      expect(r.body.ledgerBalance.amount).toBe('90.00');
      expect(r.body.difference.amount).toBe(expected);
      expect(await metric('divergent')).toBe(before + 1);

      // Não corrige: saldo e versão intactos, e a próxima reconciliação continua acusando
      expect(await db.sql(`select version as v, balance_amount::text as b from wallets where id = ?`, [w.id])).toEqual(storedBefore);
      expect((await reconcile(w.id)).body.consistent).toBe(false);
    } finally {
      await corrupt(w.id, delta.startsWith('-') ? delta.slice(1) : `-${delta}`); // restaura para o invariante do afterAll
    }
    expect((await reconcile(w.id)).body.consistent).toBe(true);
  });

  it('wallet inexistente → 404; id inválido → 400', async () => {
    expect((await reconcile(randomUUID())).status).toBe(404);
    expect((await reconcile('nao-e-uuid')).status).toBe(400);
  });

  it('reconciliações concorrentes com apostas na mesma wallet nunca acusam divergência falsa', async () => {
    const w = await newWallet(db, '1000.00');
    const before = await metric('divergent');
    const work: Promise<unknown>[] = [];
    for (let i = 0; i < 40; i++) {
      work.push(db.processTransaction.execute(command(w, 'BET', '1.00')));
      work.push(reconcile(w.id));
    }
    const results = await Promise.all(work);
    const reconciliations = results.filter((r): r is { status: number; body: any } => !!(r as any)?.body?.walletId);
    expect(reconciliations).toHaveLength(40);
    expect(reconciliations.every((r) => r.body.consistent)).toBe(true);
    expect(await metric('divergent')).toBe(before);
    expect(await balanceOf(db, w.id)).toBe('960.00');
  }, 30_000);
});
