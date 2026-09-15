import { semanticName } from '../../utils/semantic-name'

/** Verify a single authority per semantic subject and closed reuse decisions for the admitted scope. */
export function assertSemanticOwnership(payload: Record<string, unknown>): void {
  const object = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  const text = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0
  const list = (value: unknown): value is string[] =>
    Array.isArray(value) && value.length > 0 && value.every(text)
  const ownership = object(payload.semantic_ownership)
  if (
    !ownership ||
    !list(ownership.cross_clause_evidence) ||
    !Array.isArray(ownership.items) ||
    !ownership.items.length
  )
    throw new Error('CONTRACT_ADMISSION_SEMANTIC_OWNERSHIP_REQUIRED')
  const ids = new Set<string>(),
    subjects = new Set<string>(),
    requirements = new Set<string>()
  for (const entry of ownership.items) {
    const item = object(entry)
    if (
      !item ||
      !text(item.id) ||
      !text(item.subject) ||
      !text(item.authoritative_owner) ||
      !list(item.requirement_ids) ||
      !list(item.evidence) ||
      !Array.isArray(item.participants)
    )
      throw new Error('SEMANTIC_OWNERSHIP_ITEM_INVALID')
    const subject = semanticName(item.subject),
      owner = semanticName(item.authoritative_owner)
    if (!subject || !owner) throw new Error('SEMANTIC_OWNERSHIP_ITEM_INVALID')
    if (ids.has(item.id) || subjects.has(subject))
      throw new Error('SEMANTIC_OWNERSHIP_DUPLICATE_SUBJECT')
    ids.add(item.id)
    subjects.add(subject)
    item.requirement_ids.forEach((id) => requirements.add(id))
    const names = new Set<string>()
    for (const entry of item.participants) {
      const participant = object(entry)
      if (
        !participant ||
        !text(participant.name) ||
        !text(participant.relationship) ||
        !text(participant.evidence) ||
        !['DELEGATE', 'DERIVED', 'OBSERVER'].includes(String(participant.role))
      )
        throw new Error('SEMANTIC_OWNERSHIP_PARTICIPANT_INVALID')
      const name = semanticName(participant.name)
      if (!name || name === owner || names.has(name))
        throw new Error('SEMANTIC_OWNERSHIP_DUPLICATE_AUTHORITY')
      names.add(name)
    }
  }
  if (
    !list(payload.requirement_ids) ||
    requirements.size !== new Set(payload.requirement_ids).size ||
    payload.requirement_ids.some((id) => !requirements.has(id))
  )
    throw new Error('SEMANTIC_OWNERSHIP_REQUIREMENT_SCOPE_INVALID')
  if (!list(ownership.primitive_search_evidence) || !Array.isArray(ownership.primitive_decisions))
    throw new Error('SEMANTIC_OWNERSHIP_PRIMITIVE_SEARCH_REQUIRED')
  for (const entry of ownership.primitive_decisions) {
    const decision = object(entry)
    if (
      !decision ||
      !['REUSE', 'NEW_JUSTIFIED'].includes(String(decision.disposition)) ||
      !['need', 'target', 'evidence'].every((field) => text(decision[field]))
    )
      throw new Error('SEMANTIC_OWNERSHIP_PRIMITIVE_DECISION_INVALID')
  }
  if (!Array.isArray(ownership.unresolved_conflicts) || ownership.unresolved_conflicts.length)
    throw new Error('SEMANTIC_OWNERSHIP_CONFLICT_UNRESOLVED')
}
