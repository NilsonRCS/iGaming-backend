export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(reason: string) {
    super(`Invalid money value: ${reason}`);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(a: string, b: string) {
    super(`Currency mismatch: cannot operate ${a} with ${b}`);
  }
}
