import Decimal from 'decimal.js';
import { InvalidPayloadError, WalletNotFoundError } from '../errors';
import { WageringReadModel } from '../ports/wagering-read-model.port';
import { UUID_RE } from '../validation';

interface AmountView {
  amount: string;
  currency: string;
}

export interface ReconciliationView {
  walletId: string;
  consistent: boolean;
  storedBalance: AmountView;
  ledgerBalance: AmountView;
  /** storedBalance − ledgerBalance, com sinal. */
  difference: AmountView;
  ledgerEntries: number;
  walletVersion: number;
  checkedAt: string;
}

/** Pontos de observação: o resultado é logado e contado na infraestrutura. */
export interface ReconciliationObserver {
  reconciled(result: ReconciliationView): void;
}

/** 2 casas (padrão da API) ou mais quando o banco guarda mais: o valor aparece exatamente como está. */
export function formatAmount(value: Decimal): string {
  return value.toFixed(Math.max(2, value.decimalPlaces()));
}

/**
 * Seção 9.4: compara o saldo armazenado com a soma do ledger.
 * Somente leitura — divergência é sinalizada (resposta, log, métrica), nunca corrigida.
 */
export class ReconcileWalletUseCase {
  constructor(
    private readonly read: WageringReadModel,
    private readonly observer?: ReconciliationObserver,
  ) {}

  async execute(walletId: string): Promise<ReconciliationView> {
    if (typeof walletId !== 'string' || !UUID_RE.test(walletId)) {
      throw new InvalidPayloadError(['walletId must be a UUID']);
    }
    const snap = await this.read.reconciliationSnapshot(walletId.toLowerCase());
    if (!snap) throw new WalletNotFoundError(walletId);

    const stored = new Decimal(snap.storedBalance);
    const ledger = new Decimal(snap.ledgerBalance);
    const difference = stored.minus(ledger);
    const amount = (value: Decimal): AmountView => ({ amount: formatAmount(value), currency: snap.currency });

    const result: ReconciliationView = {
      walletId: snap.walletId,
      consistent: difference.isZero(),
      storedBalance: amount(stored),
      ledgerBalance: amount(ledger),
      difference: amount(difference),
      ledgerEntries: snap.ledgerEntries,
      walletVersion: snap.walletVersion,
      checkedAt: snap.checkedAt.toISOString(),
    };
    this.observer?.reconciled(result);
    return result;
  }
}
