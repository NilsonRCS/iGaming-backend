import { Money } from '../../shared/money/money';
import { DomainError } from '../../shared/errors/domain.error';
import { LedgerDirection } from './ledger-direction.enum';

export interface LedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class WalletLedgerEntry {
  private constructor(private readonly props: LedgerEntryProps) {}

  static create(params: {
    id: string;
    walletId: string;
    transactionId: string;
    direction: LedgerDirection;
    money: Money;
    balanceBefore: Money;
  }): WalletLedgerEntry {
    const { direction, money, balanceBefore } = params;

    // Calcula e valida a aritmética no momento da criação
    const balanceAfter =
      direction === LedgerDirection.CREDIT
        ? balanceBefore.add(money)
        : balanceBefore.subtract(money);

    const entry = new WalletLedgerEntry({
      ...params,
      balanceAfter,
      createdAt: new Date(),
    });

    if (!entry.isBalanced()) {
      throw new DomainError('LedgerEntry arithmetic is inconsistent');
    }

    return entry;
  }

  static rehydrate(props: LedgerEntryProps): WalletLedgerEntry {
    return new WalletLedgerEntry(props);
  }

  /** Verifica se balanceBefore ± money === balanceAfter */
  isBalanced(): boolean {
    const expected =
      this.props.direction === LedgerDirection.CREDIT
        ? this.props.balanceBefore.add(this.props.money)
        : this.props.balanceBefore.subtract(this.props.money);

    return expected.equals(this.props.balanceAfter);
  }

  get id(): string { return this.props.id; }
  get walletId(): string { return this.props.walletId; }
  get transactionId(): string { return this.props.transactionId; }
  get direction(): LedgerDirection { return this.props.direction; }
  get money(): Money { return this.props.money; }
  get balanceBefore(): Money { return this.props.balanceBefore; }
  get balanceAfter(): Money { return this.props.balanceAfter; }
  get createdAt(): Date { return this.props.createdAt; }
}
