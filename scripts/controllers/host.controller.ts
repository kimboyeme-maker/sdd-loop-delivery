import { readFileSync } from 'node:fs'
import { parseHostSpawnReceipt } from '../schemas/host'
import { hostProfile } from '../config/host'

/** The recorded evidence level of one operation, defaulting to nothing recorded. */
function operation_evidence(
  operations: Record<string, Record<string, unknown>>,
  name: string
): string {
  const value = operations[name]?.evidence
  return typeof value === 'string' ? value : 'none'
}

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
  // `evidence` is the only signal here, and it is a single field rather than prose a reader has to
  // interpret: `invoked` means someone called it in a session and it worked, `schema` means the
  // tool is exposed with that shape and nobody called it, `partial` means part of the operation was
  // exercised and the part that matters was not. Anything else is unproven.
  const unobserved = Object.entries(operations)
    .filter(([, operation]) => operation?.available === true && operation.evidence !== 'invoked')
    .map(([name]) => `${name}:${String(operation_evidence(operations, name))}`)
  // Replacement has three shapes, and telling them apart is what the startup promise depends on.
  // Without `close` nothing proves a runtime was released, but an operation that frees execution
  // capacity still allows a failed role to be stood aside and a fresh one spawned.
  const frees = Object.entries(operations).some(
    ([, operation]) => operation?.available === true && operation.releases_capacity === true
  )
  const roleReplacement = !unavailable.includes('close')
    ? 'PROFILE_SUPPORTED'
    : frees
      ? 'INTERRUPT_ONLY'
      : 'UNAVAILABLE'
  const hosting = hostProfile().role_hosting
  const mode = hosting?.default ?? 'collaboration'
  const entry = hosting?.modes?.[mode]
  return {
    ...receipt,
    roleHosting: {
      mode,
      available: entry?.available ?? false,
      // Availability is about the host; wired is about this controller. A mode that is available
      // and not wired is a fact worth knowing and not a path to plan on.
      wired: entry?.wired === true,
      planned: entry?.available === true && entry?.wired === true ? mode : 'collaboration',
      evidence: entry?.evidence ?? 'none',
      requires: entry?.requires ?? [],
      ...(entry?.available === true ? {} : { reason: entry?.reason ?? 'not declared' }),
      alternatives: Object.entries(hosting?.modes ?? {})
        .filter(([name, value]) => name !== mode && value?.available === true)
        .map(([name]) => name)
    },
    hostCapability: {
      unavailable,
      unobserved,
      // Replacement, not reuse: reuse works without `close`, replacing a role does not.
      roleReplacement,
      meaning:
        'unavailable: no exposed call. unobserved lists each available operation with its evidence: schema (shape known, never called), partial (called, but not the part that matters), none (nothing recorded). roleReplacement PROFILE_SUPPORTED closes a runtime, INTERRUPT_ONLY frees capacity without closing one, UNAVAILABLE does neither. Plan from evidence, not from protocol support.'
    },
    schemaValid: true,
    verified: false,
    hostIdentityVerified: false,
    verificationScope: 'submitted-fields-only',
    note: 'Submitted identity, model and isolation fields are structurally valid; host provenance is not authenticated by this command.'
  }
}
