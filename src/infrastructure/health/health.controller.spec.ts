import { describe, expect, it } from 'bun:test';
import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController, ShutdownState } from './health.controller';

describe('HealthController', () => {
  const health = { check: async () => ({ status: 'ok' }) } as any;

  it('live não depende de nada externo', () => {
    expect(new HealthController(health, {} as any, {} as any, new ShutdownState()).live()).toEqual({ status: 'ok' });
  });

  it('após o SIGTERM (beforeApplicationShutdown) o ready responde 503 draining', async () => {
    const shutdown = new ShutdownState();
    const c = new HealthController(health, {} as any, {} as any, shutdown);
    expect(await c.ready()).toEqual({ status: 'ok' });
    shutdown.beforeApplicationShutdown();
    expect(() => c.ready()).toThrow(ServiceUnavailableException);
  });
});
