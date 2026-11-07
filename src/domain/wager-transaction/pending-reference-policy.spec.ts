import { describe, expect, it } from 'bun:test';
import { PendingReferencePolicy } from './pending-reference-policy';
import { WagerTransaction } from './wager-transaction';
import { WagerKind, WagerStatus } from './wager-transaction.enums';
import { Money } from '../../shared/money/money';
import { DomainError } from '../../shared/errors/domain.error';

const T0 = new Date('2026-11-07T00:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

describe('PendingReferencePolicy', () => {
  const policy = PendingReferencePolicy.default();

  it('padrão: base 2s, teto 5 min, TTL 24h', () => {
    expect([policy.baseMs, policy.maxMs, policy.ttlMs]).toEqual([2_000, 300_000, 86_400_000]);
  });

  it('backoff exponencial a partir de "agora": 2s, 4s, 8s … até o teto', () => {
    const now = at(10_000);
    const delays = [1, 2, 3, 4, 8, 9, 20].map((n) => policy.nextAttemptAt(T0, n, now).getTime() - now.getTime());
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 256_000, 300_000, 300_000]);
  });

  it('nunca agenda depois do vencimento (a expiração acontece no horário)', () => {
    const now = at(86_400_000 - 1_000);
    expect(policy.nextAttemptAt(T0, 20, now)).toEqual(policy.expiresAt(T0));
  });

  it('expira exatamente no TTL', () => {
    expect(policy.isExpired(T0, at(86_400_000 - 1))).toBe(false);
    expect(policy.isExpired(T0, at(86_400_000))).toBe(true);
  });

  it.each([
    [0, 1, 1],
    [1_000, 500, 1],
    [1_000, 2_000, 0],
  ])('rejeita configuração inválida (base %p, teto %p, ttl %p)', (b, m, t) => {
    expect(() => new PendingReferencePolicy(b, m, t)).toThrow(DomainError);
  });
});

describe('WagerTransaction.scheduleReferenceRetry', () => {
  const policy = new PendingReferencePolicy(1_000, 60_000, 3_600_000);
  const refund = () =>
    WagerTransaction.rehydrate({
      id: 'tx-1',
      providerId: 'provider-a',
      externalTransactionId: 'ext-1',
      idempotencyKey: 'k',
      payloadHash: 'h',
      walletId: 'w',
      playerId: 'p',
      roundId: 'r',
      gameId: 'g',
      kind: WagerKind.REFUND,
      money: Money.from('10.00', 'BRL'),
      referenceExternalTransactionId: 'bet-1',
      status: WagerStatus.PENDING_REFERENCE,
      createdAt: T0,
    });

  it('conta a tentativa e agenda com backoff', () => {
    const tx = refund();
    expect(tx.referenceAttempts).toBe(0);
    tx.scheduleReferenceRetry(at(5_000), policy);
    expect(tx.referenceAttempts).toBe(1);
    expect(tx.nextReferenceAttemptAt).toEqual(at(6_000));
    tx.scheduleReferenceRetry(at(6_000), policy);
    expect(tx.referenceAttempts).toBe(2);
    expect(tx.nextReferenceAttemptAt).toEqual(at(8_000));
  });

  it('só PENDING_REFERENCE pode ser reagendada', () => {
    const tx = refund();
    tx.markProcessed();
    expect(() => tx.scheduleReferenceRetry(at(1), policy)).toThrow(DomainError);
  });
});
