import { Body, Controller, Get, Headers, HttpStatus, Inject, Param, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ProcessWagerTransactionResult } from '../../application/use-cases/process-wager-transaction.use-case';
import type { WagerProcessor } from '../observability/instrumented-processor';
import { HTTP_WAGER_PROCESSOR } from './tokens';
import { WageringQueries } from '../../application/queries/wagering-queries';
import { WagerTransactionView } from '../../application/views';
import { InvalidPayloadError } from '../../application/errors';
import { WagerStatus } from '../../domain/wager-transaction/wager-transaction.enums';
import { wagerCommandFromJson } from '../wager-command';

/** Seção 9.6: o status HTTP reflete o resultado de negócio da transação. */
export function statusForResult(result: ProcessWagerTransactionResult): number {
  switch (result.transaction.status) {
    case WagerStatus.PROCESSED:
      return result.idempotentReplay ? HttpStatus.OK : HttpStatus.CREATED;
    case WagerStatus.PENDING_REFERENCE:
    case WagerStatus.PENDING:
      return HttpStatus.ACCEPTED;
    case WagerStatus.REJECTED:
    case WagerStatus.FAILED:
      return HttpStatus.UNPROCESSABLE_ENTITY;
    default:
      return HttpStatus.OK;
  }
}

@Controller()
export class WageringController {
  constructor(
    @Inject(HTTP_WAGER_PROCESSOR) private readonly processTransaction: WagerProcessor,
    private readonly queries: WageringQueries,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() raw: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ProcessWagerTransactionResult> {
    if (!idempotencyKey || !idempotencyKey.trim()) {
      throw new InvalidPayloadError(['Idempotency-Key header is required']);
    }

    const result = await this.processTransaction.execute(wagerCommandFromJson(raw, idempotencyKey));

    reply.status(statusForResult(result));
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  get(@Param('transactionId') transactionId: string): Promise<WagerTransactionView> {
    return this.queries.getTransaction(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    return this.queries.getTransactionByExternalId(providerId, externalTransactionId);
  }
}
