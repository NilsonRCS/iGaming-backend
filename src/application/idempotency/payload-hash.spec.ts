import { describe, it, expect } from 'bun:test';
import { canonicalJson, payloadHash } from './payload-hash';

describe('payloadHash', () => {
  it('JSON canônico ordena chaves recursivamente e não tem espaços', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}',
    );
  });

  it('ordem das chaves não altera o hash', () => {
    expect(payloadHash({ a: '1', b: '2' })).toBe(payloadHash({ b: '2', a: '1' }));
  });

  it('valor diferente altera o hash', () => {
    expect(payloadHash({ amount: '10.00' })).not.toBe(payloadHash({ amount: '10.01' }));
  });

  it('null e ausência são diferentes', () => {
    expect(payloadHash({ a: '1', ref: null })).not.toBe(payloadHash({ a: '1' }));
  });

  it('é SHA-256 em hexadecimal', () => {
    expect(payloadHash({})).toBe('44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
  });
});
