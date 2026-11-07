import { Money } from '../shared/money/money';
import { InvalidMoneyError } from '../shared/errors/domain.error';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY_RE = /^[A-Z]{3}$/;

/** Acumula problemas de validação para devolver todos de uma vez (HTTP 400). */
export class Issues {
  readonly list: string[] = [];

  requireString(name: string, value: unknown): value is string {
    if (typeof value !== 'string' || value.trim() === '') {
      this.list.push(`${name} is required`);
      return false;
    }
    return true;
  }

  requireUuid(name: string, value: unknown): void {
    if (this.requireString(name, value) && !UUID_RE.test(value)) {
      this.list.push(`${name} must be a UUID`);
    }
  }

  parseMoney(amount: unknown, currency: unknown): Money | undefined {
    const okAmount = this.requireString('amount', amount);
    const okCurrency = this.requireString('currency', currency);
    if (!okAmount || !okCurrency) return undefined;
    if (!CURRENCY_RE.test(currency)) {
      this.list.push('currency must be an uppercase ISO 4217 code');
      return undefined;
    }
    try {
      return Money.from(amount, currency);
    } catch (e) {
      if (e instanceof InvalidMoneyError) {
        this.list.push(e.message);
        return undefined;
      }
      throw e;
    }
  }

  add(issue: string): void {
    this.list.push(issue);
  }

  get empty(): boolean {
    return this.list.length === 0;
  }
}
