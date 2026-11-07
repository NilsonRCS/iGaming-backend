import { Money } from '../../shared/money/money';
import { DomainError } from '../../shared/errors/domain.error';
import { WalletLedgerEntry } from './wallet-ledger-entry';
import { LedgerDirection } from './ledger-direction.enum';
import { randomUUID } from 'crypto';

export interface WalletProps {
  id: string;
  playerId: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private constructor(private readonly props: WalletProps) {}

  // ── Factories ──────────────────────────────────────────────────────────────

  static open(params: { playerId: string; initialBalance: Money }): Wallet {
    return new Wallet({
      id: randomUUID(),
      playerId: params.playerId,
      balance: params.initialBalance,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  static rehydrate(props: WalletProps): Wallet {
    return new Wallet(props);
  }

  // ── Operações ─────────────────────────────────────────────────────────────

  debit(money: Money, transactionId: string): WalletLedgerEntry {
    this.assertSameCurrency(money);

    const balanceBefore = this.props.balance;
    const balanceAfter = balanceBefore.subtract(money);

    if (balanceAfter.isNegative()) {
      throw new DomainError(
        `Insufficient balance: cannot debit ${money} from ${balanceBefore}`,
      );
    }

    this.props.balance = balanceAfter;
    this.props.version += 1;
    this.props.updatedAt = new Date();

    return WalletLedgerEntry.create({
      id: randomUUID(),
      walletId: this.props.id,
      transactionId,
      direction: LedgerDirection.DEBIT,
      money,
      balanceBefore,
    });
  }

  credit(money: Money, transactionId: string): WalletLedgerEntry {
    this.assertSameCurrency(money);

    const balanceBefore = this.props.balance;
    this.props.balance = balanceBefore.add(money);
    this.props.version += 1;
    this.props.updatedAt = new Date();

    return WalletLedgerEntry.create({
      id: randomUUID(),
      walletId: this.props.id,
      transactionId,
      direction: LedgerDirection.CREDIT,
      money,
      balanceBefore,
    });
  }

  /** true se o débito não deixaria o saldo negativo */
  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this.props.balance.subtract(money).isNegative();
  }

  assertSameCurrency(money: Money): void {
    if (this.props.balance.currency !== money.currency) {
      throw new DomainError(
        `Currency mismatch: wallet is ${this.props.balance.currency}, got ${money.currency}`,
      );
    }
  }

  // ── Acesso ────────────────────────────────────────────────────────────────

  get id(): string { return this.props.id; }
  get playerId(): string { return this.props.playerId; }
  get balance(): Money { return this.props.balance; }
  get version(): number { return this.props.version; }
  get currency(): string { return this.props.balance.currency; }
  get createdAt(): Date { return this.props.createdAt; }
  get updatedAt(): Date { return this.props.updatedAt; }
}
