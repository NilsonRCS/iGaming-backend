import { createHash } from 'crypto';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** JSON canônico: chaves de objetos ordenadas recursivamente, sem espaços. */
export function canonicalJson(value: Json): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 (hex) do JSON canônico. */
export function payloadHash(value: { [key: string]: Json }): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
