import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestDatabase, TestDatabase } from './support/test-database';
import { HttpApiModule } from '../../src/infrastructure/http/http-api.module';
import { MonitoringModule } from '../../src/infrastructure/health/monitoring.module';
import { REQUEST_AUTHENTICATOR, RequestAuthenticator } from '../../src/infrastructure/http/auth/request-authenticator';

/**
 * Seção 3: prova do ponto de extensão. Trocando só o REQUEST_AUTHENTICATOR (como faria um IdP),
 * as rotas de negócio passam a exigir autenticação e /health/* e /metrics continuam abertos.
 */
let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase('auth');
});

afterAll(async () => {
  await db?.destroy();
});

async function app(authenticator?: RequestAuthenticator): Promise<NestFastifyApplication> {
  let builder = Test.createTestingModule({ imports: [MikroOrmModule.forRoot(db.options), HttpApiModule, MonitoringModule] });
  if (authenticator) builder = builder.overrideProvider(REQUEST_AUTHENTICATOR).useValue(authenticator);
  const a = (await builder.compile()).createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: false });
  await a.init();
  await a.getHttpAdapter().getInstance().ready();
  return a;
}

const bearer: RequestAuthenticator = { authenticate: (r) => r.headers.authorization === 'Bearer valid-token' };

describe('Autenticação (decisão B + ponto de extensão)', () => {
  it('padrão (no-op): rotas de negócio acessíveis sem credencial', async () => {
    const a = await app();
    try {
      const r = await a.inject({ method: 'POST', url: '/wallets', payload: { playerId: randomUUID(), initialBalance: { amount: '10.00', currency: 'BRL' } } });
      expect(r.statusCode).toBe(201);
    } finally {
      await a.close();
    }
  });

  it('com um autenticador real plugado: negócio exige credencial; health e métricas seguem abertos', async () => {
    const a = await app(bearer);
    try {
      const protectedRoutes = [
        { method: 'POST' as const, url: '/wallets', payload: { playerId: randomUUID(), initialBalance: { amount: '10.00', currency: 'BRL' } } },
        { method: 'GET' as const, url: `/wallets/${randomUUID()}` },
        { method: 'GET' as const, url: `/wallets/${randomUUID()}/ledger` },
        { method: 'POST' as const, url: `/wallets/${randomUUID()}/reconciliation` },
        { method: 'POST' as const, url: '/wagering/transactions', payload: {}, headers: { 'idempotency-key': 'k' } },
        { method: 'GET' as const, url: `/wagering/transactions/${randomUUID()}` },
        { method: 'GET' as const, url: '/providers/provider-a/wagering/transactions/x' },
      ];
      for (const route of protectedRoutes) {
        const r = await a.inject(route);
        expect({ url: route.url, status: r.statusCode }).toEqual({ url: route.url, status: 401 });
        expect(JSON.parse(r.body)).toMatchObject({ error: 'UNAUTHORIZED' });
      }

      // Com credencial válida a mesma rota funciona
      const ok = await a.inject({
        method: 'POST',
        url: '/wallets',
        payload: { playerId: randomUUID(), initialBalance: { amount: '10.00', currency: 'BRL' } },
        headers: { authorization: 'Bearer valid-token' },
      });
      expect(ok.statusCode).toBe(201);

      // Seção 3: /health/* abertos (e /metrics, para o Prometheus)
      expect((await a.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
      expect((await a.inject({ method: 'GET', url: '/health/ready' })).statusCode).not.toBe(401);
      expect((await a.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(200);
    } finally {
      await a.close();
    }
  });
});
