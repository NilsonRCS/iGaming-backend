import { Logger } from '@nestjs/common';
import { EventPublisher } from '../../application/ports/outbox.port';
import { WagerTransactionProcessor } from './sqs-wager-consumer';

/**
 * Injeção de falhas para os testes de concorrência com processos reais (Etapa 9).
 * Ativa somente quando a variável correspondente está definida; em produção ela não existe.
 *
 * SIGKILL é a morte abrupta real: nenhum hook de shutdown roda, nenhuma transação
 * pendente é concluída, nenhum ACK é enviado.
 */
export type Kill = () => void;

const sigkillSelf: Kill = () => process.kill(process.pid, 'SIGKILL');

function killAfter(n: number, what: string, kill: Kill): () => void {
  let count = 0;
  return () => {
    if (++count === n) {
      new Logger('FaultInjection').warn(`Killing process with SIGKILL after ${what} #${n}`);
      kill();
    }
  };
}

function threshold(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const n = Number(env[name]);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** `CHAOS_KILL_AFTER_COMMIT=n`: morre depois do n-ésimo commit de mensagem e antes do ACK. */
export function withKillAfterCommit(
  processor: WagerTransactionProcessor,
  env = process.env,
  kill: Kill = sigkillSelf,
): WagerTransactionProcessor {
  const n = threshold(env, 'CHAOS_KILL_AFTER_COMMIT');
  if (!n) return processor;
  const tick = killAfter(n, 'commit', kill);
  return {
    async execute(command) {
      const result = await processor.execute(command); // commit já feito aqui
      tick();
      return result;
    },
  };
}

/** `CHAOS_KILL_AFTER_PUBLISH=n`: morre depois do n-ésimo envio ao SQS e antes do commit que marca published_at. */
export function withKillAfterPublish(publisher: EventPublisher, env = process.env, kill: Kill = sigkillSelf): EventPublisher {
  const n = threshold(env, 'CHAOS_KILL_AFTER_PUBLISH');
  if (!n) return publisher;
  const tick = killAfter(n, 'publish', kill);
  return {
    async publish(message) {
      await publisher.publish(message);
      tick();
    },
  };
}
