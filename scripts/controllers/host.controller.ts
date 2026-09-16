import { readFileSync } from 'node:fs'
import { parseHostSpawnReceipt } from '../schemas/host'
import { hostProfile } from '../config/host'

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
  // Say what this host cannot do before anything is dispatched. An operation the profile marks
  // unavailable, or marks available with no observation, is a limit the delivery will meet later at
  // a worse moment: a role that has to be replaced rather than reused needs `close` to release
  // capacity, and nothing else proves the slot came back. Naming it here keeps the run from
  // promising a recovery it cannot perform.
  const operations = hostProfile().operations as Record<string, Record<string, unknown>>
  const unavailable = Object.entries(operations)
    .filter(([, operation]) => operation?.available !== true)
    .map(([name]) => name)
  const unobserved = Object.entries(operations)
    .filter(
      ([, operation]) =>
        operation?.available === true &&
        typeof operation.notes === 'string' &&
        !/\bObserved\b/.test(operation.notes)
    )
    .map(([name]) => name)
  return {
    ...receipt,
    hostCapability: {
      unavailable,
      unobserved,
      // Replacement, not reuse: reuse works without `close`, replacing a role does not.
      roleReplacement: unavailable.includes('close') ? 'UNAVAILABLE' : 'PROFILE_SUPPORTED',
      meaning:
        'unavailable: no exposed call. unobserved: the protocol defines it but nobody recorded a successful call here. Plan from observations, not from protocol support.'
    },
    schemaValid: true,
    verified: false,
    hostIdentityVerified: false,
    verificationScope: 'submitted-fields-only',
    note: 'Submitted identity, model and isolation fields are structurally valid; host provenance is not authenticated by this command.'
  }
}
