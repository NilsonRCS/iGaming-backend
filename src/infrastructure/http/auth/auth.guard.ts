import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC } from './public.decorator';
import { REQUEST_AUTHENTICATOR } from './request-authenticator';
import type { RequestAuthenticator } from './request-authenticator';

/**
 * Guard global: rota `@Public()` passa direto; as demais dependem do RequestAuthenticator.
 * Com o NoopRequestAuthenticator (decisão B) todas passam.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(REQUEST_AUTHENTICATOR) private readonly authenticator: RequestAuthenticator,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    if (await this.authenticator.authenticate(request)) return true;
    throw new UnauthorizedException({ error: 'UNAUTHORIZED', message: 'Authentication required' });
  }
}
