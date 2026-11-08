import { describe, expect, it } from 'bun:test';
import { InvalidPayloadError, WalletNotFoundError } from '../errors';
import { ReconciliationSnapshot, WageringReadModel } from '../ports/wagering-read-model.port';
import { ReconcileWalletUseCase, ReconciliationView } from './reconcile-wallet.use-case';

const ID = '7f8e0a52-8c1d-4c55-9e5c-3d2b1a0f9e11';

function readModel(snapshot: Partial<ReconciliationSnapshot> | null): WageringReadModel {
  return {
    reconciliationSnapshot: async () =>
      snapshot && {
        walletId: ID,
        currency: 'BRL',
        storedBalance: '100.0000',
        ledgerBalance: '100.0000',
        ledgerEntries: 3,
        walletVersion: 4,
        checkedAt: new Date('2026-11-08T12:00:00.000Z'),
        ...snapshot,
      },
  } as unknown as WageringReadModel;
}

describe('ReconcileWalletUseCase', () => {
  it('consistente: diferença zero, valores no formato da API', async () => {
    const r = await new ReconcileWalletUseCase(readModel({})).execute(ID);
    expect(r).toEqual({
      walletId: ID,
      consistent: true,
      storedBalance: { amount: '100.00', currency: 'BRL' },
      ledgerBalance: { amount: '100.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      ledgerEntries: 3,
      walletVersion: 4,
      checkedAt: '2026-11-08T12:00:00.000Z',
    });
  });

  it.each([
    ['saldo acima do ledger', '100.0100', '100.0000', '0.01'],
    ['saldo abaixo do ledger (diferença negativa)', '99.9900', '100.0000', '-0.01'],
    ['valor corrompido com 4 casas aparece exato', '100.0050', '100.0000', '0.005'],
    ['ledger negativo (mais débitos que créditos)', '0.0000', '-5.0000', '5.00'],
  ])('%s → divergente, diferença com sinal', async (_, stored, ledger, diff) => {
    const r = await new ReconcileWalletUseCase(readModel({ storedBalance: stored, ledgerBalance: ledger })).execute(ID);
    expect(r.consistent).toBe(false);
    expect(r.difference.amount).toBe(diff);
  });

  it('notifica o observador com o resultado (log e métrica na infraestrutura)', async () => {
    const seen: ReconciliationView[] = [];
    await new ReconcileWalletUseCase(readModel({ storedBalance: '1.0000' }), { reconciled: (r) => seen.push(r) }).execute(ID);
    expect(seen).toHaveLength(1);
    expect(seen[0].consistent).toBe(false);
  });

  it('wallet inexistente → WalletNotFoundError; id inválido → InvalidPayloadError', async () => {
    await expect(new ReconcileWalletUseCase(readModel(null)).execute(ID)).rejects.toBeInstanceOf(WalletNotFoundError);
    await expect(new ReconcileWalletUseCase(readModel({})).execute('nao-e-uuid')).rejects.toBeInstanceOf(InvalidPayloadError);
  });
});
