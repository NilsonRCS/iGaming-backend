import { expect } from 'bun:test';
import { randomUUID } from 'crypto';
import { AppInstance } from './app-instances';

export const PROVIDER = 'provider-a';
export type ApiWallet = { id: string; playerId: string };

export async function openWallet(app: AppInstance, amount = '100.00', headers: Record<string, string> = {}): Promise<ApiWallet> {
  const r = await app.http('POST', '/wallets', { playerId: randomUUID(), initialBalance: { amount, currency: 'BRL' } }, headers);
  expect(r.status).toBe(201);
  return { id: r.body.id, playerId: r.body.playerId };
}

/** Corpo de transação no formato da fila (com idempotencyKey); `submit` move a chave para o header. */
export function tx(w: ApiWallet, kind: string, amount: string, extra: { ext?: string; ref?: string } = {}) {
  const externalTransactionId = extra.ext ?? `ext-${kind}-${randomUUID()}`;
  return {
    idempotencyKey: `${PROVIDER}:${externalTransactionId}`,
    providerId: PROVIDER,
    externalTransactionId,
    walletId: w.id,
    playerId: w.playerId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: { amount, currency: 'BRL' },
    referenceExternalTransactionId: extra.ref ?? null,
  };
}

export type TxBody = ReturnType<typeof tx>;

export function submit(app: AppInstance, body: TxBody, headers: Record<string, string> = {}) {
  const { idempotencyKey, ...payload } = body;
  return app.http('POST', '/wagering/transactions', payload, { 'idempotency-key': idempotencyKey, ...headers });
}
