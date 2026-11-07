import { describe, expect, it } from 'bun:test';
import { InvalidPayloadError } from '../../application/errors';
import { parseWagerMessage } from './wager-message';

const body = {
  idempotencyKey: 'provider-a:tx-1',
  providerId: 'provider-a',
  externalTransactionId: 'tx-1',
  walletId: '7f8e0a52-8c1d-4c55-9e5c-3d2b1a0f9e11',
  playerId: '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b',
  roundId: 'r1',
  gameId: 'g1',
  kind: 'REFUND',
  money: { amount: '10.00', currency: 'BRL' },
  referenceExternalTransactionId: 'tx-0',
};

describe('parseWagerMessage', () => {
  it('converte o corpo JSON no mesmo comando da API HTTP, com a chave vinda do corpo', () => {
    expect(parseWagerMessage(JSON.stringify(body))).toEqual({
      idempotencyKey: 'provider-a:tx-1',
      providerId: 'provider-a',
      externalTransactionId: 'tx-1',
      walletId: body.walletId,
      playerId: body.playerId,
      roundId: 'r1',
      gameId: 'g1',
      kind: 'REFUND',
      amount: '10.00',
      currency: 'BRL',
      referenceExternalTransactionId: 'tx-0',
    });
  });

  it('não inclui inbox: quem define é o consumidor', () => {
    expect(parseWagerMessage(JSON.stringify(body)).inbox).toBeUndefined();
  });

  it.each([['não é json'], [''], [undefined as unknown as string]])('JSON inválido (%p) → InvalidPayloadError', (raw) => {
    expect(() => parseWagerMessage(raw)).toThrow(InvalidPayloadError);
  });

  it.each([['[]'], ['"texto"'], ['null'], ['42']])('corpo que não é objeto (%p) → InvalidPayloadError', (raw) => {
    expect(() => parseWagerMessage(raw)).toThrow(InvalidPayloadError);
  });

  it('money que não é objeto → InvalidPayloadError', () => {
    expect(() => parseWagerMessage(JSON.stringify({ ...body, money: 'x' }))).toThrow(InvalidPayloadError);
  });

  it('mantém valores numéricos como vieram para a validação do use case rejeitar', () => {
    const command = parseWagerMessage(JSON.stringify({ ...body, money: { amount: 10, currency: 'BRL' } }));
    expect(command.amount as unknown).toBe(10);
  });
});
