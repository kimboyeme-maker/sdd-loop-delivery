import { readFileSync } from 'node:fs'
import { parseHostSpawnReceipt } from '../schemas/host'

/**
 * Validate submitted receipt structure without authenticating its host provenance.
 * This local file reader has no host attestation channel; successful parsing must
 * not manufacture verified identity, model selection or isolation evidence.
 */
export function hostReceipt(path: string): Readonly<Record<string, unknown>> {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error('HOST_RECEIPT_JSON_INVALID')
  }
  const receipt = parseHostSpawnReceipt(value)
  return {
    ...receipt,
    schemaValid: true,
    verified: false,
    hostIdentityVerified: false,
    verificationScope: 'submitted-fields-only',
    note: 'Submitted identity, model and isolation fields are structurally valid; host provenance is not authenticated by this command.'
  }
}
