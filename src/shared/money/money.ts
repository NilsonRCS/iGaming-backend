import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from '../errors/domain.error';

// Configuração global: sem notação científica, precisão alta
Decimal.set({ toExpPos: 20, toExpNeg: -20 });

// Regex: rejeita notação científica (e/E)
const SCIENTIFIC_NOTATION_RE = /[eE]/;

export class Money {
  private readonly _amount: Decimal;
  private readonly _currency: string;

  private constructor(amount: Decimal, currency: string) {
    this._amount = amount;
    this._currency = currency;
  }

  // ── Factories ──────────────────────────────────────────────────────────────

  static from(amount: string, currency: string): Money {
    Money.validateCurrency(currency);
    Money.validateAmountString(amount);

    let decimal: Decimal;
    try {
      decimal = new Decimal(amount);
    } catch {
      throw new InvalidMoneyError(`value is not numeric: "${amount}"`);
    }

    if (decimal.isNaN() || !decimal.isFinite()) {
      throw new InvalidMoneyError('value must be a finite number');
    }

    if (decimal.isNegative()) {
      throw new InvalidMoneyError('value must not be negative');
    }

    // Verifica casas decimais: decimalPlaces() conta apenas as casas
    if (decimal.decimalPlaces() > 2) {
      throw new InvalidMoneyError(
        `value must have at most 2 decimal places, got: ${amount}`,
      );
    }

    return new Money(decimal.toDecimalPlaces(2), currency);
  }

  static zero(currency: string): Money {
    Money.validateCurrency(currency);
    return new Money(new Decimal('0.00'), currency);
  }

  // ── Operações (imutáveis) ──────────────────────────────────────────────────

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this._amount.plus(other._amount), this._currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this._amount.minus(other._amount), this._currency);
  }

  negate(): Money {
    return new Money(this._amount.negated(), this._currency);
  }

  // ── Comparações ───────────────────────────────────────────────────────────

  isZero(): boolean {
    return this._amount.isZero();
  }

  isPositive(): boolean {
    return this._amount.isPositive() && !this._amount.isZero();
  }

  isNegative(): boolean {
    return this._amount.isNegative();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this._amount.lessThan(other._amount);
  }

  equals(other: Money): boolean {
    return this._currency === other._currency && this._amount.equals(other._amount);
  }

  // ── Acesso ────────────────────────────────────────────────────────────────

  get amount(): string {
    return this._amount.toFixed(2); // sempre 2 casas: "25.00"
  }

  get currency(): string {
    return this._currency;
  }

  // ── Serialização ──────────────────────────────────────────────────────────

  toJSON(): { amount: string; currency: string } {
    return { amount: this.amount, currency: this._currency };
  }

  toString(): string {
    return `${this.amount} ${this._currency}`;
  }

  // ── Validação de moeda ────────────────────────────────────────────────────

  assertSameCurrency(other: Money): void {
    if (this._currency !== other._currency) {
      throw new CurrencyMismatchError(this._currency, other._currency);
    }
  }

  // ── Validações internas ───────────────────────────────────────────────────

  private static validateAmountString(amount: string): void {
    if (typeof amount !== 'string' || amount.trim() === '') {
      throw new InvalidMoneyError('amount must be a non-empty string');
    }

    if (SCIENTIFIC_NOTATION_RE.test(amount)) {
      throw new InvalidMoneyError(
        `scientific notation is not allowed: "${amount}"`,
      );
    }
  }

  private static validateCurrency(currency: string): void {
    if (typeof currency !== 'string' || currency.trim().length !== 3) {
      throw new InvalidMoneyError('currency must be a 3-character ISO code');
    }
  }
}
