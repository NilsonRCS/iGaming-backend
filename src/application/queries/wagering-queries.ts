import { InvalidPayloadError, TransactionNotFoundError, WalletNotFoundError } from '../errors';
import { LedgerPosition, WageringReadModel } from '../ports/wagering-read-model.port';
import { UUID_RE } from '../validation';
import { LedgerPageView, toTransactionView, toWalletView, WagerTransactionView, WalletView } from '../views';

export const LEDGER_DEFAULT_LIMIT = 50;
export const LEDGER_MAX_LIMIT = 100;

/** Cursor opaco: base64url de { c: createdAt, i: id }. Estável porque o ledger é append-only. */
export function encodeLedgerCursor(position: LedgerPosition): string {
  return Buffer.from(JSON.stringify({ c: position.createdAt, i: position.id })).toString('base64url');
}

export function decodeLedgerCursor(cursor: string): LedgerPosition {
  try {
    const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { c?: unknown; i?: unknown };
    if (typeof raw.c === 'string' && typeof raw.i === 'string' && UUID_RE.test(raw.i) && !Number.isNaN(Date.parse(raw.c))) {
      return { createdAt: raw.c, id: raw.i };
    }
  } catch {
    // cai no erro abaixo
  }
  throw new InvalidPayloadError(['cursor is invalid']);
}

function requireUuid(name: string, value: string): string {
  if (!UUID_RE.test(value)) throw new InvalidPayloadError([`${name} must be a UUID`]);
  return value.toLowerCase();
}

function parseLimit(limit: string | undefined): number {
  if (limit === undefined || limit === '') return LEDGER_DEFAULT_LIMIT;
  const n = /^\d+$/.test(limit) ? Number(limit) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > LEDGER_MAX_LIMIT) {
    throw new InvalidPayloadError([`limit must be an integer between 1 and ${LEDGER_MAX_LIMIT}`]);
  }
  return n;
}

export class WageringQueries {
  constructor(private readonly read: WageringReadModel) {}

  async getWallet(walletId: string): Promise<WalletView> {
    const wallet = await this.read.findWallet(requireUuid('walletId', walletId));
    if (!wallet) throw new WalletNotFoundError(walletId);
    return toWalletView(wallet);
  }

  async getTransaction(transactionId: string): Promise<WagerTransactionView> {
    const tx = await this.read.findTransaction(requireUuid('transactionId', transactionId));
    if (!tx) throw new TransactionNotFoundError(transactionId);
    return toTransactionView(tx);
  }

  async getTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransactionView> {
    const tx = await this.read.findTransactionByExternalId(providerId, externalTransactionId);
    if (!tx) throw new TransactionNotFoundError(`${providerId}/${externalTransactionId}`);
    return toTransactionView(tx);
  }

  async getLedger(walletId: string, cursor?: string, limit?: string): Promise<LedgerPageView> {
    const id = requireUuid('walletId', walletId);
    const size = parseLimit(limit);
    const after = cursor ? decodeLedgerCursor(cursor) : null;

    if (!(await this.read.findWallet(id))) throw new WalletNotFoundError(walletId);

    // Busca um item a mais para saber se existe próxima página
    const rows = await this.read.listLedger(id, after, size + 1);
    const page = rows.slice(0, size);
    const hasMore = rows.length > size;

    return {
      items: page.map((r) => r.entry),
      nextCursor: hasMore ? encodeLedgerCursor(page[page.length - 1].position) : null,
    };
  }
}
