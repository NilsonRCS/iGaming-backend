import { describe, expect, it } from 'bun:test';
import { DriverException, UniqueConstraintViolationException } from '@mikro-orm/core';
import { TransientInfrastructureError, UniqueViolationError } from '../../application/errors';
import { translateDriverError } from './driver-errors';

const pgError = (fields: Record<string, unknown>) => Object.assign(new Error(String(fields.message ?? 'pg error')), fields);

describe('translateDriverError', () => {
  it.each([
    ['conexão recusada', pgError({ code: 'ECONNREFUSED' })],
    ['banco recusando conexões (FATAL 55000)', pgError({ code: '55000', severity: 'FATAL', message: 'database "x" is not currently accepting connections' })],
    ['conexão derrubada pelo administrador (57P01)', pgError({ code: '57P01', severity: 'FATAL' })],
    ['banco subindo (57P03)', pgError({ code: '57P03' })],
    ['conexões esgotadas (53300)', pgError({ code: '53300' })],
    ['exceção de conexão (08006)', pgError({ code: '08006' })],
    ['serialização (40001)', pgError({ code: '40001' })],
    ['conexão morta durante a transação (knex)', new Error('Transaction query already complete, run with DEBUG=knex:tx for more info')],
    ['pool sem conexão (knex)', new Error('Knex: Timeout acquiring a connection. The pool is probably full.')],
  ])('%s → TransientInfrastructureError', (_, error) => {
    expect(translateDriverError(error)).toBeInstanceOf(TransientInfrastructureError);
  });

  it('olha a causa original guardada pelo MikroORM (previous)', () => {
    const wrapped = new DriverException(pgError({ code: '57P01', severity: 'FATAL', message: 'terminating connection due to administrator command' }));
    expect(translateDriverError(wrapped)).toBeInstanceOf(TransientInfrastructureError);
  });

  it('UNIQUE violada → UniqueViolationError', () => {
    const e = new UniqueConstraintViolationException(pgError({ code: '23505', constraint: 'uq_x' }));
    expect(translateDriverError(e)).toBeInstanceOf(UniqueViolationError);
  });

  it.each([
    ['erro de sintaxe', pgError({ code: '42601', severity: 'ERROR' })],
    ['check violado', pgError({ code: '23514', severity: 'ERROR' })],
    ['55000 que não é de conexão (ERROR)', pgError({ code: '55000', severity: 'ERROR' })],
    ['erro comum', new Error('boom')],
  ])('%s não é transitório (passa adiante)', (_, error) => {
    expect(translateDriverError(error)).toBe(error);
  });
});
