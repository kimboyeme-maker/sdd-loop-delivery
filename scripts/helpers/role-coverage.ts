import { assertRoleEvidence } from './role-evidence'

type Item = Record<string, unknown>
const object = (value: unknown): Item =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : {}
const strings = (value: unknown): string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : []
const items = (value: unknown): Item[] => (Array.isArray(value) ? value.map(object) : [])
const equal = (a: readonly string[], b: readonly string[]): boolean => {
  const left = new Set(a),
    right = new Set(b)
  return left.size === right.size && [...left].every((id) => right.has(id))
}

/** Obtain the packet from the sealed lease, never from a role's claimed scope. */
function packetId(state: Item, event: Item): unknown {
  const actor = object(event.actor)
  return object(object(state.issued_leases)[String(actor.lease_id)]).packet_id
}

/** Check the role's semantic review against the current admitted ownership map. */
export function assertSemanticCoverage(state: Item, admission: Item, event: Item): void {
  const packet = packetId(state, event)
  const packets = items(admission.execution_packets)
  const selected = packet ? packets.find((item) => item.id === packet) : undefined
  if (packet && !selected) throw new Error('EXECUTION_PACKET_CLAIM_SCOPE_INVALID')
  const requirements = strings(selected?.requirement_ids)
  const required = items(object(admission.semantic_ownership).items)
    .filter(
      (item) => !packet || strings(item.requirement_ids).some((id) => requirements.includes(id))
    )
    .map((item) => String(item.id))
  const observed = strings(object(object(event.payload).semantic_ownership_review).semantic_ids)
  if (!equal(required, observed)) throw new Error('SEMANTIC_OWNERSHIP_REVIEW_SCOPE_INVALID')
}

/** An implementation stage closes only when its authenticated packet receipts cover admission.
 * Readbacks and reviews cover their assigned packet; final acceptance is checked separately.
 * Event order is the native ledger order, so no synthetic sequence numbers are needed.
 */
export function assertPacketCoverage(
  state: Item,
  admission: Item,
  events: readonly Item[],
  event: Item,
  aggregateImplementation = true
): void {
  let required = items(admission.execution_packets).map((item) => String(item.id))
  let observed = strings(object(event.payload).execution_packet_ids)
  const packet = packetId(state, event)
  if (packet) {
    if (typeof packet !== 'string' || !required.includes(packet) || !equal(observed, [packet]))
      throw new Error('EXECUTION_PACKET_CLAIM_SCOPE_INVALID')
    if (event.type === 'implementation' && aggregateImplementation) {
      const entered = events.findLastIndex(
        (item) => item.type === 'state_transition' && object(item.payload).to === 'IMPLEMENTING'
      )
      observed = events
        .slice(entered + 1)
        .filter((item) => {
          if (
            item.type !== 'implementation' ||
            item.role !== 'operator' ||
            item.contract_revision !== state.contract_revision
          )
            return false
          assertRoleEvidence(state, item, 'operator')
          return true
        })
        .flatMap((item) => strings(object(item.payload).execution_packet_ids))
    } else required = [packet]
  }
  if (!equal(required, observed)) throw new Error('EXECUTION_PACKET_CLAIM_SCOPE_INVALID')
}

/** Reporting unauthorized changes is permitted on a failed review, never on PASS. */
export function assertModificationCoverage(
  admission: Item,
  event: Item,
  allowUnauthorizedReport = false
): void {
  const allowed = strings(admission.modification_packages)
  if (!allowed.length && !allowUnauthorizedReport)
    throw new Error('MODIFICATION_SCOPE_ADMISSION_MISSING')
  const unauthorized = strings(object(event.payload).changed_packages).filter(
    (name) => !allowed.includes(name)
  )
  if (unauthorized.length && !allowUnauthorizedReport)
    throw new Error(`UNAUTHORIZED_PACKAGE_MODIFICATION: ${unauthorized.sort().join(', ')}`)
}

/** Acceptance definitions a FINAL_VERIFY verdict must observe: every Must-Ship requirement's. */
export function mustShipAcceptance(contract: Item): Item[] {
  const required = new Set(
    items(contract.requirements)
      .filter((item) => item.kind === 'must-ship')
      .flatMap((item) => strings(item.acceptance))
  )
  return items(contract.acceptance).filter((item) => required.has(String(item.id)))
}

/**
 * Bind observed checks to accepted methods and packages, without treating scope as execution proof.
 * Enforced when the verdict is written, so every consumer (transition, requirement, Finding)
 * reads a PASS whose checks actually observe each claimed acceptance id.
 */
export function assertObservationCoverage(
  admission: Item,
  event: Item,
  finalAcceptance?: readonly Item[]
): void {
  const payload = object(event.payload)
  const surfaces = finalAcceptance
    ? finalAcceptance.map((item) => ({
        acceptance_ids: [item.id],
        packages: item.packages,
        method: item.method
      }))
    : items(object(admission.verification_scope).surfaces)
  const admitted = finalAcceptance
    ? finalAcceptance.map((item) => String(item.id))
    : strings(admission.acceptance_ids)
  const observed: string[] = []
  for (const check of items(payload.checks)) {
    const ids = strings(check.acceptance_ids)
    if (!ids.length || ids.some((id) => !admitted.includes(id)))
      throw new Error('VERIFICATION_CHECK_ACCEPTANCE_SCOPE_INVALID')
    observed.push(...ids)
    const matching = surfaces.filter((surface) =>
      ids.every((id) => strings(surface.acceptance_ids).includes(id))
    )
    const packages = matching.flatMap((surface) => strings(surface.packages))
    if (
      !matching.length ||
      !matching.some((surface) => surface.method === check.method) ||
      strings(check.packages).some((name) => !packages.includes(name))
    )
      throw new Error('VERIFICATION_CHECK_ORACLE_BINDING_INVALID')
  }
  if (payload.result === 'PASS' && !equal(observed, strings(payload.acceptance_ids)))
    throw new Error('VERIFICATION_CHECK_ACCEPTANCE_COVERAGE_INVALID')
}
