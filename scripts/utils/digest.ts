import { createHash } from 'node:crypto'

/** Return a lowercase SHA-256 digest for bytes or UTF-8 text at a boundary. */
export function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}
