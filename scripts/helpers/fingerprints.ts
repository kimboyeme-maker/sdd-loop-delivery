import { sha256 } from '../utils/digest'

/** Fingerprint already-canonical bytes; callers remain responsible for choosing the codec. */
export function fingerprint(value: Uint8Array | string): string {
  return sha256(value)
}
