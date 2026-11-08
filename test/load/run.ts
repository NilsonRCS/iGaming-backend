/**
 * Teste de carga (seção 13.4) contra as instâncias do docker compose.
 *
 *   docker compose up -d && bun run migration:up && bun run test:load
 *
 * Variáveis: LOAD_TARGETS (padrão http://localhost:3000,http://localhost:3001),
 * LOAD_WALLETS, LOAD_HOT_WALLETS, LOAD_OPERATIONS, LOAD_CONCURRENCY.
 * Termina com código 1 se houver erro 5xx/rede ou qualquer wallet divergente.
 */
import { randomUUID } from 'crypto';
import os from 'os';

const TARGETS = (process.env.LOAD_TARGETS ?? 'http://localhost:3000,http://localhost:3001').split(',').map((s) => s.trim());
const WALLETS = Number(process.env.LOAD_WALLETS ?? 40);
const HOT_WALLETS = Number(process.env.LOAD_HOT_WALLETS ?? 4);
const OPERATIONS = Number(process.env.LOAD_OPERATIONS ?? 4000);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 64);
const PROVIDER = 'load-provider';

type Wallet = { id: string; playerId: string; bets: string[]; refunded: Set<string> };
type Request = { idempotencyKey: string; body: Record<string, unknown>; label: string };

let rr = 0;
const target = () => TARGETS[rr++ % TARGETS.length];

async function http(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

async function scrape(): Promise<Map<string, number>> {
  const total = new Map<string, number>();
  for (const t of TARGETS) {
    const text = await (await fetch(`${t}/metrics`)).text();
    for (const line of text.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const i = line.lastIndexOf(' ');
      const v = Number(line.slice(i + 1));
      if (Number.isFinite(v)) total.set(line.slice(0, i), (total.get(line.slice(0, i)) ?? 0) + v);
    }
  }
  return total;
}

/** Soma de todas as séries cujo nome (e labels) começa com `prefix`. */
const sum = (m: Map<string, number>, prefix: string) => [...m].filter(([k]) => k.startsWith(prefix)).reduce((s, [, v]) => s + v, 0);
/** Gauges globais (lidos do banco/SQS): cada instância reporta o mesmo valor, então usa o de uma só. */
async function gauge(name: string): Promise<number> {
  const text = await (await fetch(`${TARGETS[0]}/metrics`)).text();
  const line = text.split('\n').find((l) => l.startsWith(name + ' '));
  return line ? Number(line.split(' ')[1]) : NaN;
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const amount = () => `${1 + Math.floor(Math.random() * 20)}.00`;

function nextRequest(wallets: Wallet[], sent: Request[]): Request {
  // 30% das operações em poucas wallets "quentes": disputa real pelo lock
  const w = Math.random() < 0.3 ? wallets[Math.floor(Math.random() * HOT_WALLETS)] : wallets[HOT_WALLETS + Math.floor(Math.random() * (wallets.length - HOT_WALLETS))];
  const roll = Math.random();

  if (roll < 0.1 && sent.length > 0) {
    const replay = sent[Math.floor(Math.random() * sent.length)];
    return { ...replay, label: 'REPLAY' };
  }

  const ext = `load-${randomUUID()}`;
  const base = { providerId: PROVIDER, externalTransactionId: ext, walletId: w.id, playerId: w.playerId, roundId: 'round-1', gameId: 'game-1' };
  let body: Record<string, unknown>;
  let label: string;

  if (roll < 0.25 && w.bets.length > 0) {
    body = { ...base, kind: 'WIN', money: { amount: amount(), currency: 'BRL' }, referenceExternalTransactionId: w.bets[Math.floor(Math.random() * w.bets.length)] };
    label = 'WIN';
  } else if (roll < 0.3 && w.bets.length > 0) {
    const candidates = w.bets.filter((b) => !w.refunded.has(b));
    const bet = candidates[Math.floor(Math.random() * candidates.length)];
    if (bet) {
      w.refunded.add(bet);
      const original = sent.find((r) => r.body.externalTransactionId === bet);
      body = { ...base, kind: 'REFUND', money: original!.body.money, referenceExternalTransactionId: bet };
      label = 'REFUND';
    } else {
      body = { ...base, kind: 'LOSS', money: { amount: '0', currency: 'BRL' } };
      label = 'LOSS';
    }
  } else if (roll < 0.4) {
    body = { ...base, kind: 'LOSS', money: { amount: '0', currency: 'BRL' } };
    label = 'LOSS';
  } else if (roll < 0.42) {
    body = { ...base, kind: 'BET', money: { amount: '999999.00', currency: 'BRL' } }; // rejeitada: saldo insuficiente
    label = 'BET_REJECTED';
  } else {
    body = { ...base, kind: 'BET', money: { amount: amount(), currency: 'BRL' } };
    label = 'BET';
    w.bets.push(ext);
  }
  const req = { idempotencyKey: `${PROVIDER}:${ext}`, body, label };
  sent.push(req);
  return req;
}

async function main() {
  console.log(`Alvos: ${TARGETS.join(', ')} | wallets ${WALLETS} (${HOT_WALLETS} quentes) | operações ${OPERATIONS} | concorrência ${CONCURRENCY}`);
  for (const t of TARGETS) {
    const r = await http('GET', `${t}/health/ready`);
    if (r.status !== 200) throw new Error(`${t} não está pronto (${r.status}). Suba o compose e aplique as migrations.`);
  }
  const before = await scrape();

  const wallets: Wallet[] = [];
  for (let i = 0; i < WALLETS; i++) {
    const r = await http('POST', `${target()}/wallets`, { playerId: randomUUID(), initialBalance: { amount: '10000.00', currency: 'BRL' } });
    if (r.status !== 201) throw new Error(`falha ao criar wallet: ${r.status}`);
    wallets.push({ id: r.body.id, playerId: r.body.playerId, bets: [], refunded: new Set() });
  }

  const sent: Request[] = [];
  const latencies: number[] = [];
  const byStatus = new Map<string, number>();
  const byLabel = new Map<string, number>();
  let networkErrors = 0;
  let issued = 0;
  let maxOutboxLag = 0;
  let maxOutboxPending = 0;

  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      maxOutboxLag = Math.max(maxOutboxLag, (await gauge('outbox_lag_seconds')) || 0);
      maxOutboxPending = Math.max(maxOutboxPending, (await gauge('outbox_pending_messages')) || 0);
      await new Promise((r) => setTimeout(r, 250));
    }
  })();

  const started = performance.now();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (issued < OPERATIONS) {
        issued++;
        const req = nextRequest(wallets, sent);
        const t0 = performance.now();
        try {
          const r = await http('POST', `${target()}/wagering/transactions`, req.body, { 'idempotency-key': req.idempotencyKey });
          latencies.push(performance.now() - t0);
          byStatus.set(String(r.status), (byStatus.get(String(r.status)) ?? 0) + 1);
        } catch {
          networkErrors++;
        }
        byLabel.set(req.label, (byLabel.get(req.label) ?? 0) + 1);
      }
    }),
  );
  const elapsed = (performance.now() - started) / 1000;
  sampling = false;
  await sampler;

  // Drenagem: outbox publicado e referências pendentes resolvidas
  const drainStart = performance.now();
  for (let i = 0; i < 240; i++) {
    if ((await gauge('outbox_pending_messages')) === 0 && (await gauge('pending_reference_transactions')) === 0) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const drainSeconds = (performance.now() - drainStart) / 1000;
  const pendingLeft = await gauge('pending_reference_transactions');
  const outboxLeft = await gauge('outbox_pending_messages');

  // Invariante final: saldo == ledger em todas as wallets do teste
  let divergent = 0;
  for (const w of wallets) {
    const r = await http('POST', `${target()}/wallets/${w.id}/reconciliation`);
    if (r.status !== 200 || !r.body.consistent) divergent++;
  }

  const after = await scrape();
  const delta = (prefix: string) => sum(after, prefix) - sum(before, prefix);
  const sorted = [...latencies].sort((a, b) => a - b);
  const errors5xx = [...byStatus].filter(([s]) => s.startsWith('5')).reduce((s, [, n]) => s + n, 0);
  const total = latencies.length + networkErrors;
  const ms = (v: number) => `${v.toFixed(1)} ms`;

  const report = [
    '## Resultado',
    '',
    '| Ambiente | |',
    '|---|---|',
    `| CPU | ${os.cpus()[0]?.model ?? '?'} × ${os.cpus().length} |`,
    `| Memória | ${(os.totalmem() / 2 ** 30).toFixed(1)} GiB |`,
    `| SO | ${os.type()} ${os.release()} |`,
    `| Runtime do teste | Bun ${Bun.version} |`,
    `| Instâncias | ${TARGETS.length} (${TARGETS.join(', ')}) |`,
    '',
    '| Métrica | Valor |',
    '|---|---|',
    `| Operações | ${total} (${[...byLabel].map(([k, v]) => `${k} ${v}`).join(', ')}) |`,
    `| Duração | ${elapsed.toFixed(1)} s |`,
    `| Throughput | ${(total / elapsed).toFixed(0)} req/s |`,
    `| Latência p50 / p95 / p99 | ${ms(pct(sorted, 50))} / ${ms(pct(sorted, 95))} / ${ms(pct(sorted, 99))} |`,
    `| Latência máx. | ${ms(sorted[sorted.length - 1])} |`,
    `| Status HTTP | ${[...byStatus].sort().map(([k, v]) => `${k}: ${v}`).join(', ')} |`,
    `| Taxa de erro (5xx + rede) | ${(((errors5xx + networkErrors) / total) * 100).toFixed(2)}% |`,
    `| Conflitos de lock (wallet) | ${delta('wallet_lock_conflicts_total')} |`,
    `| Duplicatas detectadas | ${delta('wagering_duplicates_total')} |`,
    `| Retries por UNIQUE (corrida entre instâncias) | ${delta('wagering_retries_total{operation="unique_violation"}')} |`,
    `| Outbox lag máx. / pendentes máx. durante a carga | ${maxOutboxLag.toFixed(2)} s / ${maxOutboxPending} |`,
    `| Drenagem (outbox + PENDING_REFERENCE) após a carga | ${drainSeconds.toFixed(1)} s (restantes: outbox ${outboxLeft}, pendentes ${pendingLeft}) |`,
    `| Wallets reconciliadas / divergentes | ${wallets.length} / ${divergent} |`,
  ].join('\n');
  console.log('\n' + report);

  if (errors5xx + networkErrors > 0 || divergent > 0) {
    console.error('\nFALHA: erros de infraestrutura ou divergência de saldo');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
