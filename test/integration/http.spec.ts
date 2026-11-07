import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'crypto';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestDatabase, TestDatabase } from './support/test-database';
import { createHttpApp } from './support/http-app';
import { walletsOutOfBalance } from './support/fixtures';

let db: TestDatabase;
let app: NestFastifyApplication;

beforeAll(async () => {
  db = await createTestDatabase('http');
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

type Res = { statusCode: number; body: any; headers: Record<string, unknown> };

async function call(method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const r = await app.inject({ method, url, payload: payload as never, headers });
  return { statusCode: r.statusCode, body: r.body ? JSON.parse(r.body) : undefined, headers: r.headers };
}

async function createWallet(amount = '100.00', currency = 'BRL') {
  const r = await call('POST', '/wallets', { playerId: randomUUID(), initialBalance: { amount, currency } });
  expect(r.statusCode).toBe(201);
  return r.body as { id: string; playerId: string };
}

function txBody(wallet: { id: string; playerId: string }, kind: string, amount: string, extra: Record<string, unknown> = {}) {
  return {
    providerId: 'provider-a',
    externalTransactionId: `ext-${randomUUID()}`,
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: { amount, currency: 'BRL' },
    ...extra,
  };
}

const submit = (body: Record<string, unknown>, key = `provider-a:${body.externalTransactionId}`) =>
  call('POST', '/wagering/transactions', body, { 'idempotency-key': key });

describe('POST /wallets', () => {
  it('201 com a wallet criada', async () => {
    const playerId = randomUUID();
    const r = await call('POST', '/wallets', { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    expect(r.statusCode).toBe(201);
    expect(r.body).toMatchObject({ playerId, balance: { amount: '100.00', currency: 'BRL' }, version: 2 });
  });

  it('409 para wallet duplicada', async () => {
    const playerId = randomUUID();
    const body = { playerId, initialBalance: { amount: '1.00', currency: 'BRL' } };
    expect((await call('POST', '/wallets', body)).statusCode).toBe(201);
    const r = await call('POST', '/wallets', body);
    expect(r.statusCode).toBe(409);
    expect(r.body.error).toBe('WALLET_ALREADY_EXISTS');
  });

  it('400 com a lista de problemas; valor como number é rejeitado', async () => {
    const r = await call('POST', '/wallets', { playerId: 'x', initialBalance: { amount: 100, currency: 'BRL' } });
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toBe('INVALID_PAYLOAD');
    expect(r.body.issues).toEqual(['playerId must be a UUID', 'amount must be a string']);
  });

  it('400 para corpo que não é objeto', async () => {
    expect((await call('POST', '/wallets', [1, 2])).statusCode).toBe(400);
  });
});

describe('GET /wallets/:walletId', () => {
  it('200 com saldo atual', async () => {
    const w = await createWallet('42.50');
    const r = await call('GET', `/wallets/${w.id}`);
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatchObject({ id: w.id, balance: { amount: '42.50', currency: 'BRL' } });
  });

  it('404 para wallet inexistente e 400 para id malformado', async () => {
    expect((await call('GET', `/wallets/${randomUUID()}`)).statusCode).toBe(404);
    expect((await call('GET', `/wallets/nao-e-uuid`)).statusCode).toBe(400);
  });
});

describe('POST /wagering/transactions', () => {
  it('400 sem header Idempotency-Key', async () => {
    const w = await createWallet();
    const r = await call('POST', '/wagering/transactions', txBody(w, 'BET', '1.00'));
    expect(r.statusCode).toBe(400);
    expect(r.body.issues).toEqual(['Idempotency-Key header is required']);
  });

  it('201 na primeira vez, 200 com idempotentReplay no replay idêntico', async () => {
    const w = await createWallet();
    const body = txBody(w, 'BET', '25.00');

    const first = await submit(body);
    expect(first.statusCode).toBe(201);
    expect(first.body.idempotentReplay).toBe(false);
    expect(first.body.transaction).toMatchObject({ status: 'PROCESSED', money: { amount: '25.00', currency: 'BRL' } });

    const replay = await submit(body);
    expect(replay.statusCode).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(replay.body.transaction.id).toBe(first.body.transaction.id);

    expect((await call('GET', `/wallets/${w.id}`)).body.balance.amount).toBe('75.00');
  });

  it('409 para a mesma chave com payload diferente', async () => {
    const w = await createWallet();
    const body = txBody(w, 'BET', '25.00');
    await submit(body);
    const r = await submit({ ...body, money: { amount: '30.00', currency: 'BRL' } });
    expect(r.statusCode).toBe(409);
    expect(r.body.error).toBe('PAYLOAD_CONFLICT');
  });

  it('422 para rejeição de negócio, inclusive no replay', async () => {
    const w = await createWallet('10.00');
    const body = txBody(w, 'BET', '10.01');
    const r = await submit(body);
    expect(r.statusCode).toBe(422);
    expect(r.body.transaction).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_BALANCE' });

    const replay = await submit(body);
    expect(replay.statusCode).toBe(422);
    expect(replay.body.idempotentReplay).toBe(true);
  });

  it('202 para referência ausente (PENDING_REFERENCE)', async () => {
    const w = await createWallet();
    const r = await submit(txBody(w, 'REFUND', '5.00', { referenceExternalTransactionId: 'bet-que-nao-chegou' }));
    expect(r.statusCode).toBe(202);
    expect(r.body.transaction.status).toBe('PENDING_REFERENCE');
  });

  it('404 para wallet inexistente', async () => {
    const r = await submit(txBody({ id: randomUUID(), playerId: randomUUID() }, 'BET', '1.00'));
    expect(r.statusCode).toBe(404);
    expect(r.body.error).toBe('WALLET_NOT_FOUND');
  });

  it('400 para valor como number, OPENING e JSON malformado', async () => {
    const w = await createWallet();
    expect((await submit(txBody(w, 'BET', 10 as unknown as string))).statusCode).toBe(400);
    expect((await submit(txBody(w, 'OPENING', '1.00'))).statusCode).toBe(400);

    const r = await app.inject({
      method: 'POST',
      url: '/wagering/transactions',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k' },
      payload: '{"providerId":',
    });
    expect(r.statusCode).toBe(400);
  });

  it('fluxo BET → WIN → ROLLBACK do WIN pela API', async () => {
    const w = await createWallet('100.00');
    const bet = await submit(txBody(w, 'BET', '20.00'));
    const win = await submit(txBody(w, 'WIN', '50.00', { referenceExternalTransactionId: bet.body.transaction.externalTransactionId }));
    expect(win.statusCode).toBe(201);
    const rollback = await submit(
      txBody(w, 'ROLLBACK', '50.00', { referenceExternalTransactionId: win.body.transaction.externalTransactionId }),
    );
    expect(rollback.statusCode).toBe(201);
    expect((await call('GET', `/wallets/${w.id}`)).body.balance.amount).toBe('80.00');
  });
});

describe('GET de transações', () => {
  it('por id e por (providerId, externalTransactionId)', async () => {
    const w = await createWallet();
    const body = txBody(w, 'BET', '3.00');
    const created = (await submit(body)).body.transaction;

    const byId = await call('GET', `/wagering/transactions/${created.id}`);
    expect(byId.statusCode).toBe(200);
    expect(byId.body).toEqual(created);

    const byExt = await call('GET', `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`);
    expect(byExt.statusCode).toBe(200);
    expect(byExt.body.id).toBe(created.id);
  });

  it('404 quando não existe; 400 para id malformado', async () => {
    expect((await call('GET', `/wagering/transactions/${randomUUID()}`)).statusCode).toBe(404);
    expect((await call('GET', `/wagering/transactions/abc`)).statusCode).toBe(400);
    expect((await call('GET', `/providers/provider-a/wagering/transactions/nao-existe`)).statusCode).toBe(404);
  });
});

describe('GET /wallets/:walletId/ledger', () => {
  it('pagina com cursor opaco, do mais recente ao mais antigo, sem repetir nem pular', async () => {
    const w = await createWallet('100.00');
    for (let i = 1; i <= 7; i++) await submit(txBody(w, 'BET', `${i}.00`));

    const seen: any[] = [];
    let cursor: string | null = null;
    const sizes: number[] = [];
    do {
      const url: string = `/wallets/${w.id}/ledger?limit=3${cursor ? `&cursor=${cursor}` : ''}`;
      const r = await call('GET', url);
      expect(r.statusCode).toBe(200);
      sizes.push(r.body.items.length);
      seen.push(...r.body.items);
      cursor = r.body.nextCursor;
    } while (cursor);

    expect(sizes).toEqual([3, 3, 2]);
    expect(new Set(seen.map((e) => e.id)).size).toBe(8);
    expect(seen.map((e) => e.money.amount)).toEqual(['7.00', '6.00', '5.00', '4.00', '3.00', '2.00', '1.00', '100.00']);
    expect(seen[0]).toMatchObject({ direction: 'DEBIT', balanceBefore: { amount: '79.00' }, balanceAfter: { amount: '72.00' } });
    expect(seen[7]).toMatchObject({ direction: 'CREDIT', balanceBefore: { amount: '0.00' }, balanceAfter: { amount: '100.00' } });
  });

  it('cursor continua estável depois de novos lançamentos', async () => {
    const w = await createWallet('100.00');
    for (let i = 1; i <= 4; i++) await submit(txBody(w, 'BET', `${i}.00`));

    const first = await call('GET', `/wallets/${w.id}/ledger?limit=2`);
    await submit(txBody(w, 'BET', '9.00'));
    const next = await call('GET', `/wallets/${w.id}/ledger?limit=10&cursor=${first.body.nextCursor}`);

    expect(first.body.items.map((e: any) => e.money.amount)).toEqual(['4.00', '3.00']);
    expect(next.body.items.map((e: any) => e.money.amount)).toEqual(['2.00', '1.00', '100.00']);
    expect(next.body.nextCursor).toBeNull();
  });

  it('limit padrão 50; limit e cursor inválidos → 400; wallet inexistente → 404', async () => {
    const w = await createWallet('1.00');
    const r = await call('GET', `/wallets/${w.id}/ledger`);
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatchObject({ nextCursor: null });
    expect(r.body.items).toHaveLength(1);

    for (const q of ['limit=0', 'limit=101', 'limit=abc', 'cursor=lixo']) {
      expect((await call('GET', `/wallets/${w.id}/ledger?${q}`)).statusCode).toBe(400);
    }
    expect((await call('GET', `/wallets/${randomUUID()}/ledger`)).statusCode).toBe(404);
  });
});
