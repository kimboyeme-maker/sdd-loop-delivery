type Item = Record<string, unknown>
const object = (value: unknown): Item =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : {}
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim()

/** Validate recovery evidence without treating a reported PASS as independent host proof. */
export function assertExecutionSubstrate(state: Item, payload: Item): void {
  if (['SHIP', 'BLOCKED', 'CANCELLED'].includes(String(state.phase)))
    throw new Error('EXECUTION_SUBSTRATE_TERMINAL_STATE')
  for (const field of [
    'authority_continuity',
    'dependency_environment_health',
    'inventory_determinism',
    'critical_oracle_sensitivity',
    'repository_fingerprint'
  ]) {
    const check = object(payload[field])
    if (
      !['PASS', 'NOT_APPLICABLE'].includes(String(check.status)) ||
      !Array.isArray(check.evidence) ||
      !check.evidence.length ||
      !check.evidence.every(text)
    )
      throw new Error(`EXECUTION_SUBSTRATE_${field.toUpperCase()}_INVALID`)
  }
  const environment = object(payload.environment_fingerprint)
  for (const field of [
    'source_fingerprint',
    'lockfile_fingerprint',
    'tool_runtime_version',
    'workspace_link_fingerprint',
    'resolver_mode'
  ])
    if (!text(environment[field]))
      throw new Error(`ENVIRONMENT_FINGERPRINT_${field.toUpperCase()}_REQUIRED`)
  if (
    !Array.isArray(payload.changed_evidence_surfaces) ||
    !payload.changed_evidence_surfaces.every(text)
  )
    throw new Error('EXECUTION_SUBSTRATE_CHANGED_SURFACES_INVALID')
  if (
    !['CONTROLLER_RECOVERY', 'AGENT_REPLACEMENT', 'ENVIRONMENT_INCIDENT'].includes(
      String(payload.trigger)
    )
  )
    throw new Error('EXECUTION_SUBSTRATE_TRIGGER_INVALID')
  if (payload.trigger === 'AGENT_REPLACEMENT') {
    if (!['operator', 'architect'].includes(String(payload.agent_role)))
      throw new Error('EXECUTION_SUBSTRATE_REPLACEMENT_ROLE_INVALID')
    for (const field of ['replaced_agent_id', 'replacement_agent_id'])
      if (!text(payload[field]))
        throw new Error(`EXECUTION_SUBSTRATE_${field.toUpperCase()}_REQUIRED`)
  }
  if (
    state.execution_substrate_required != null &&
    object(state.execution_substrate_required).trigger !== payload.trigger
  )
    throw new Error('EXECUTION_SUBSTRATE_TRIGGER_MISMATCH')
}
