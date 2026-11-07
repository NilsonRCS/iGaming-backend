import { ChildProcess, spawn } from 'child_process';
import { createServer } from 'net';
import { resolve } from 'path';
import { TestDatabase } from './test-database';
import { TEST_AWS_ENDPOINT } from './test-queues';

const ROOT = resolve(__dirname, '../../..');

export interface HttpResult {
  status: number;
  body: any;
}

/** Processo real da aplicação (`bun src/main.ts`): HTTP + consumidor SQS + publisher do outbox. */
export interface AppInstance {
  name: string;
  port: number;
  /** Saída combinada stdout/stderr do processo. */
  logs(): string;
  http(method: 'GET' | 'POST', path: string, body?: unknown, headers?: Record<string, string>): Promise<HttpResult>;
  /** Envia o sinal e espera o processo sair. */
  stop(signal?: NodeJS.Signals): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Resolve quando o processo sai (inclusive por SIGKILL autoinfligido). */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  isAlive(): boolean;
}

export interface InstanceTopology {
  db: TestDatabase;
  queueUrl: string;
  dlqUrl: string;
  eventsQueueUrl: string;
}

async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.once('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => ok(port));
    });
  });
}

/**
 * Sobe uma instância isolada: banco e filas do teste, nunca os do compose.
 * Todas as variáveis relevantes são explícitas (o .env aponta para a rede interna do compose).
 */
export async function startInstance(
  name: string,
  topology: InstanceTopology,
  overrides: Record<string, string> = {},
  start: { waitReady?: boolean } = {},
): Promise<AppInstance> {
  const port = await freePort();
  const opts = topology.db.options as Record<string, unknown>;
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    NODE_ENV: 'test',
    APP_PORT: String(port),
    POSTGRES_HOST: String(opts.host),
    POSTGRES_PORT: String(opts.port),
    POSTGRES_DB: String(opts.dbName),
    POSTGRES_USER: String(opts.user ?? 'igaming'),
    POSTGRES_PASSWORD: String(opts.password ?? 'igaming'),
    AWS_ENDPOINT: TEST_AWS_ENDPOINT,
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    SQS_QUEUE_URL: topology.queueUrl,
    SQS_DLQ_URL: topology.dlqUrl,
    SQS_EVENTS_QUEUE_URL: topology.eventsQueueUrl,
    SQS_CONSUMER_NAME: 'wager-processor',
    SQS_WAIT_TIME_SECONDS: '1',
    SQS_BACKOFF_BASE_SECONDS: '1',
    SQS_BACKOFF_MAX_SECONDS: '2',
    OUTBOX_POLL_INTERVAL_MS: '100',
    ...overrides,
  };

  // --no-env-file: o .env do repositório é do compose (hosts internos, flags de dev) e não pode vazar no teste
  const child: ChildProcess = spawn('bun', ['--no-env-file', 'src/main.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout!.on('data', (d) => (output += d));
  child.stderr!.on('data', (d) => (output += d));

  let alive = true;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((ok) =>
    child.once('exit', (code, signal) => {
      alive = false;
      ok({ code, signal });
    }),
  );

  const base = `http://127.0.0.1:${port}`;
  const instance: AppInstance = {
    name,
    port,
    exited,
    logs: () => output,
    isAlive: () => alive,
    async http(method, path, body, headers = {}) {
      const res = await fetch(base + path, {
        method,
        headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : undefined };
    },
    async stop(signal = 'SIGTERM') {
      if (alive) child.kill(signal);
      return exited;
    },
  };

  // Instância que deve morrer no bootstrap (falha injetada) não chega a responder HTTP
  if (start.waitReady === false) return instance;

  // Pronta quando responde HTTP (consumidor e publisher já iniciaram no bootstrap)
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (!alive) throw new Error(`instance ${name} exited during startup:\n${output}`);
    try {
      const r = await fetch(`${base}/wallets/00000000-0000-4000-8000-000000000000`);
      if (r.status === 404) break;
    } catch {
      // ainda subindo
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`instance ${name} not ready in 30s:\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return instance;
}

/** Quantas vezes uma linha de log aparece na saída da instância. */
export function countLogs(instance: AppInstance, needle: string): number {
  return instance.logs().split('\n').filter((l) => l.includes(needle)).length;
}

/** Soma o campo numérico `field` nas linhas de log que contêm `needle` (ex.: published do relay). */
export function sumLogField(instance: AppInstance, needle: string, field: string): number {
  const re = new RegExp(`"${field}":(\\d+)`);
  return instance
    .logs()
    .split('\n')
    .filter((l) => l.includes(needle))
    .reduce((acc, l) => acc + Number(l.match(re)?.[1] ?? 0), 0);
}
