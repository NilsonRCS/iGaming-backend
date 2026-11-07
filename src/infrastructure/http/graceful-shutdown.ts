import type { FastifyInstance } from 'fastify';

const IDLE_SWEEP_MS = 100;

/**
 * SIGTERM sem esperar o keepAliveTimeout (72s no Fastify).
 *
 * O Fastify fecha as conexões keep-alive ociosas uma única vez, no início do close.
 * Uma requisição em andamento nesse momento termina depois, a conexão fica ociosa e o
 * server.close() espera o keepAliveTimeout inteiro — mais que o prazo de parada do
 * orquestrador (10s no Docker), que então mata o processo com SIGKILL.
 *
 * Durante o fechamento, varre as conexões ociosas periodicamente: requisições em
 * andamento terminam normalmente; só conexões sem requisição são encerradas.
 */
export function closeIdleConnectionsWhileClosing(fastify: FastifyInstance): void {
  fastify.addHook('preClose', (done) => {
    const server = fastify.server as typeof fastify.server & { closeIdleConnections?: () => void };
    if (typeof server.closeIdleConnections === 'function') {
      const sweep = setInterval(() => server.closeIdleConnections!(), IDLE_SWEEP_MS);
      sweep.unref();
      server.once('close', () => clearInterval(sweep));
    }
    done();
  });
}
