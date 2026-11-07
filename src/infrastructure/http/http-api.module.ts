import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { WageringModule } from '../wagering.module';
import { WalletsController } from './wallets.controller';
import { WageringController } from './wagering.controller';
import { ApplicationExceptionFilter } from './application-exception.filter';

@Module({
  imports: [WageringModule],
  controllers: [WalletsController, WageringController],
  providers: [{ provide: APP_FILTER, useClass: ApplicationExceptionFilter }],
})
export class HttpApiModule {}
