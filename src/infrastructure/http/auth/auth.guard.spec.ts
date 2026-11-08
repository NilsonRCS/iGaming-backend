import { describe, expect, it } from 'bun:test';
import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from './auth.guard';
import { IS_PUBLIC } from './public.decorator';
import { NoopRequestAuthenticator, RequestAuthenticator } from './request-authenticator';

function context(isPublic: boolean, headers: Record<string, string> = {}) {
  const handler = () => undefined;
  if (isPublic) Reflect.defineMetadata(IS_PUBLIC, true, handler);
  class Ctrl {}
  return {
    getHandler: () => handler,
    getClass: () => Ctrl,
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as any;
}

const deny: RequestAuthenticator = { authenticate: () => false };

describe('AuthGuard', () => {
  it('decisão B: com o autenticador no-op toda rota passa', async () => {
    expect(await new AuthGuard(new Reflector(), new NoopRequestAuthenticator()).canActivate(context(false))).toBe(true);
  });

  it('rota @Public() passa sem consultar o autenticador', async () => {
    let called = false;
    const spy: RequestAuthenticator = { authenticate: () => ((called = true), false) };
    expect(await new AuthGuard(new Reflector(), spy).canActivate(context(true))).toBe(true);
    expect(called).toBe(false);
  });

  it('rota protegida recusada pelo autenticador → 401', async () => {
    await expect(new AuthGuard(new Reflector(), deny).canActivate(context(false))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('o autenticador recebe os headers da requisição', async () => {
    const byToken: RequestAuthenticator = { authenticate: (r) => r.headers.authorization === 'Bearer ok' };
    const guard = new AuthGuard(new Reflector(), byToken);
    expect(await guard.canActivate(context(false, { authorization: 'Bearer ok' }))).toBe(true);
    await expect(guard.canActivate(context(false, { authorization: 'Bearer x' }))).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
