import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { OpenWalletUseCase } from '../../application/use-cases/open-wallet.use-case';
import { WageringQueries } from '../../application/queries/wagering-queries';
import { ReconcileWalletUseCase, ReconciliationView } from '../../application/use-cases/reconcile-wallet.use-case';
import { LedgerPageView, WalletView } from '../../application/views';
import { asObject, nestedObject } from '../wager-command';

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly openWallet: OpenWalletUseCase,
    private readonly queries: WageringQueries,
    private readonly reconcile: ReconcileWalletUseCase,
  ) {}

  /** Cria a wallet; saldo inicial > 0 gera OPENING + CREDIT na mesma transação SQL. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() raw: unknown): Promise<WalletView> {
    const body = asObject(raw);
    const initial = nestedObject(body, 'initialBalance');
    return this.openWallet.execute({
      playerId: body.playerId as string,
      initialBalance: { amount: initial.amount as string, currency: initial.currency as string },
    });
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string): Promise<WalletView> {
    return this.queries.getWallet(walletId);
  }

  @Get(':walletId/ledger')
  ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<LedgerPageView> {
    return this.queries.getLedger(walletId, cursor, limit);
  }

  /** Seção 9.4: saldo armazenado × soma do ledger. Somente leitura; divergência sinalizada, nunca corrigida. */
  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  reconciliation(@Param('walletId') walletId: string): Promise<ReconciliationView> {
    return this.reconcile.execute(walletId);
  }
}
