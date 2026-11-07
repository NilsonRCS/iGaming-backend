import { Body, Controller, Get, Headers, HttpStatus, Param, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  ProcessWagerTransactionResult,
  ProcessWagerTransactionUseCase,
} from '../../application/use-cases/process-wager-transaction.use-case';
import { WageringQueries } from '../../application/queries/wagering-queries';
import { WagerTransactionView } from '../../application/views';
import { InvalidPayloadError } from '../../application/errors';
import { WagerStatus } from '../../domain/wager-transaction/wager-transaction.enums';
import { asObject, nestedObject } from './request-body';

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
    private readonly processTransaction: ProcessWagerTransactionUseCase,
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

    const body = asObject(raw);
    const money = nestedObject(body, 'money');

    const result = await this.processTransaction.execute({
      idempotencyKey,
      providerId: body.providerId as string,
      externalTransactionId: body.externalTransactionId as string,
      walletId: body.walletId as string,
      playerId: body.playerId as string,
      roundId: body.roundId as string,
      gameId: body.gameId as string,
      kind: body.kind as string,
      amount: money.amount as string,
      currency: money.currency as string,
      referenceExternalTransactionId: body.referenceExternalTransactionId as string | null | undefined,
    });

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
