import { describe, it, expect } from 'bun:test';
import { Money } from './money';
import { CurrencyMismatchError, InvalidMoneyError } from '../errors/domain.error';

describe('Money', () => {
  // ── Factories ──────────────────────────────────────────────────────────────

  describe('Money.from()', () => {
    it('cria Money com valor e moeda válidos', () => {
      const m = Money.from('25.00', 'BRL');
      expect(m.amount).toBe('25.00');
      expect(m.currency).toBe('BRL');
    });

    it('aceita valor inteiro e normaliza para 2 casas', () => {
      const m = Money.from('100', 'USD');
      expect(m.amount).toBe('100.00');
    });

    it('aceita 1 casa decimal e normaliza', () => {
      const m = Money.from('9.5', 'EUR');
      expect(m.amount).toBe('9.50');
    });

    it('aceita zero', () => {
      const m = Money.from('0', 'BRL');
      expect(m.amount).toBe('0.00');
      expect(m.isZero()).toBe(true);
    });

    it('rejeita valor negativo', () => {
      expect(() => Money.from('-1.00', 'BRL')).toThrow(InvalidMoneyError);
    });

    it('rejeita mais de 2 casas decimais', () => {
      expect(() => Money.from('1.001', 'BRL')).toThrow(InvalidMoneyError);
    });

    it('rejeita notação científica (1e5)', () => {
      expect(() => Money.from('1e5', 'BRL')).toThrow(InvalidMoneyError);
    });

    it('rejeita notação científica (1E+5)', () => {
      expect(() => Money.from('1E+5', 'BRL')).toThrow(InvalidMoneyError);
    });

    it('rejeita string vazia', () => {
      expect(() => Money.from('', 'BRL')).toThrow(InvalidMoneyError);
    });

    it('rejeita string não numérica', () => {
      expect(() => Money.from('abc', 'BRL')).toThrow();
    });

    it('rejeita moeda com menos de 3 chars', () => {
      expect(() => Money.from('10.00', 'BR')).toThrow(InvalidMoneyError);
    });

    it('rejeita moeda com mais de 3 chars', () => {
      expect(() => Money.from('10.00', 'BRLS')).toThrow(InvalidMoneyError);
    });
  });

  describe('Money.zero()', () => {
    it('cria Money zerado', () => {
      const m = Money.zero('BRL');
      expect(m.amount).toBe('0.00');
      expect(m.isZero()).toBe(true);
    });
  });

  // ── Operações aritméticas ──────────────────────────────────────────────────

  describe('add()', () => {
    it('soma dois valores da mesma moeda', () => {
      const result = Money.from('25.00', 'BRL').add(Money.from('10.00', 'BRL'));
      expect(result.amount).toBe('35.00');
    });

    it('soma mantém 2 casas decimais', () => {
      const result = Money.from('0.10', 'BRL').add(Money.from('0.20', 'BRL'));
      expect(result.amount).toBe('0.30');
    });

    it('lança erro com moedas diferentes', () => {
      expect(() =>
        Money.from('10.00', 'BRL').add(Money.from('10.00', 'USD')),
      ).toThrow(CurrencyMismatchError);
    });
  });

  describe('subtract()', () => {
    it('subtrai dois valores da mesma moeda', () => {
      const result = Money.from('10.00', 'BRL').subtract(Money.from('3.50', 'BRL'));
      expect(result.amount).toBe('6.50');
    });

    it('pode resultar em negativo (checagem de saldo é responsabilidade do domínio)', () => {
      const result = Money.from('5.00', 'BRL').subtract(Money.from('10.00', 'BRL'));
      expect(result.isNegative()).toBe(true);
    });

    it('lança erro com moedas diferentes', () => {
      expect(() =>
        Money.from('10.00', 'BRL').subtract(Money.from('5.00', 'USD')),
      ).toThrow(CurrencyMismatchError);
    });
  });

  describe('negate()', () => {
    it('nega um valor positivo', () => {
      const result = Money.from('10.00', 'BRL').negate();
      expect(result.isNegative()).toBe(true);
      expect(result.amount).toBe('-10.00');
    });
  });

  // ── Comparações ───────────────────────────────────────────────────────────

  describe('isZero()', () => {
    it('retorna true para zero', () => {
      expect(Money.zero('BRL').isZero()).toBe(true);
    });

    it('retorna false para valor positivo', () => {
      expect(Money.from('0.01', 'BRL').isZero()).toBe(false);
    });
  });

  describe('isPositive()', () => {
    it('retorna true para valor acima de zero', () => {
      expect(Money.from('0.01', 'BRL').isPositive()).toBe(true);
    });

    it('retorna false para zero', () => {
      expect(Money.zero('BRL').isPositive()).toBe(false);
    });
  });

  describe('isNegative()', () => {
    it('retorna true após subtração que gera negativo', () => {
      const result = Money.from('5.00', 'BRL').subtract(Money.from('10.00', 'BRL'));
      expect(result.isNegative()).toBe(true);
    });
  });

  describe('isLessThan()', () => {
    it('retorna true quando menor', () => {
      expect(
        Money.from('5.00', 'BRL').isLessThan(Money.from('10.00', 'BRL')),
      ).toBe(true);
    });

    it('retorna false quando igual', () => {
      expect(
        Money.from('10.00', 'BRL').isLessThan(Money.from('10.00', 'BRL')),
      ).toBe(false);
    });

    it('retorna false quando maior', () => {
      expect(
        Money.from('15.00', 'BRL').isLessThan(Money.from('10.00', 'BRL')),
      ).toBe(false);
    });

    it('lança erro com moedas diferentes', () => {
      expect(() =>
        Money.from('5.00', 'BRL').isLessThan(Money.from('10.00', 'USD')),
      ).toThrow(CurrencyMismatchError);
    });
  });

  describe('equals()', () => {
    it('retorna true para mesmo valor e moeda', () => {
      expect(Money.from('5.00', 'BRL').equals(Money.from('5.00', 'BRL'))).toBe(true);
    });

    it('retorna false para moeda diferente', () => {
      expect(Money.from('5.00', 'BRL').equals(Money.from('5.00', 'USD'))).toBe(false);
    });

    it('retorna false para valor diferente', () => {
      expect(Money.from('5.00', 'BRL').equals(Money.from('6.00', 'BRL'))).toBe(false);
    });
  });

  // ── Serialização ──────────────────────────────────────────────────────────

  describe('toJSON()', () => {
    it('serializa com amount como string de 2 casas', () => {
      const json = Money.from('25.00', 'BRL').toJSON();
      expect(json).toEqual({ amount: '25.00', currency: 'BRL' });
    });

    it('amount é sempre string — nunca number', () => {
      const json = Money.from('10.00', 'BRL').toJSON();
      expect(typeof json.amount).toBe('string');
    });
  });

  // ── Imutabilidade ─────────────────────────────────────────────────────────

  describe('imutabilidade', () => {
    it('add() não modifica o original', () => {
      const a = Money.from('10.00', 'BRL');
      a.add(Money.from('5.00', 'BRL'));
      expect(a.amount).toBe('10.00');
    });

    it('subtract() não modifica o original', () => {
      const a = Money.from('10.00', 'BRL');
      a.subtract(Money.from('5.00', 'BRL'));
      expect(a.amount).toBe('10.00');
    });
  });

  // ── assertSameCurrency ────────────────────────────────────────────────────

  describe('assertSameCurrency()', () => {
    it('não lança quando mesma moeda', () => {
      expect(() =>
        Money.from('10.00', 'BRL').assertSameCurrency(Money.from('5.00', 'BRL')),
      ).not.toThrow();
    });

    it('lança CurrencyMismatchError quando moedas diferem', () => {
      expect(() =>
        Money.from('10.00', 'BRL').assertSameCurrency(Money.from('5.00', 'USD')),
      ).toThrow(CurrencyMismatchError);
    });
  });
});
