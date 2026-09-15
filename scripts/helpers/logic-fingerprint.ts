import { contractJsonText } from '../domain/contract'
import { canonicalJson } from '../resource/wire/canonical-json'
import { sha256 } from '../utils/digest'

/**
 * Hash native logic values independently of object insertion order. Source-byte
 * binding separately detects edits to the full document. Historical Python
 * fingerprints are not accepted or reproduced by this engine.
 */
export function logicFingerprint(source: string): string | undefined {
  const json = contractJsonText(source)
  if (json === null) return undefined
  const wire = JSON.parse(json) as Record<string, unknown>
  if (!wire || typeof wire !== 'object' || Array.isArray(wire))
    throw new Error('CONTRACT_JSON_INVALID')
  if (!Object.hasOwn(wire, 'implementation_logic')) return undefined
  return sha256(canonicalJson(wire.implementation_logic))
}
