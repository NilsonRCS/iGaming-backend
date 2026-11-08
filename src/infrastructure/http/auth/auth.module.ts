import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.guard';
import { NoopRequestAuthenticator, REQUEST_AUTHENTICATOR } from './request-authenticator';

/** Seção 3, decisão B: guard global no-op com o autenticador como ponto de extensão. */
@Global()
@Module({
  providers: [
    { provide: REQUEST_AUTHENTICATOR, useClass: NoopRequestAuthenticator },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [REQUEST_AUTHENTICATOR],
})
export class AuthModule {}
