/** Require one explicit executable route, with containment and downstream observations. */
export function assertAdmissionRoute(payload: Record<string, unknown>): void {
  const text = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0
  for (const field of [
    'round_outcome',
    'rollback_or_containment',
    'top_failure_mode',
    'early_falsifier'
  ]) {
    if (!text(payload[field])) throw new Error(`CONTRACT_ADMISSION_${field.toUpperCase()}_REQUIRED`)
  }
  for (const field of ['problem_evidence', 'downstream_impacts']) {
    const values = payload[field]
    if (!Array.isArray(values) || !values.length || !values.every(text))
      throw new Error(`CONTRACT_ADMISSION_${field.toUpperCase()}_REQUIRED`)
  }
  const conventional = payload.conventional_route as Record<string, unknown> | undefined
  if (
    !conventional ||
    typeof conventional !== 'object' ||
    Array.isArray(conventional) ||
    !text(conventional.summary) ||
    !text(conventional.evidence) ||
    !['FIT', 'PARTIAL', 'NOT_FIT'].includes(String(conventional.applicability))
  )
    throw new Error('CONTRACT_ADMISSION_CONVENTIONAL_ROUTE_INVALID')
  if (
    !text(payload.selected_route_id) ||
    !Array.isArray(payload.route_options) ||
    !payload.route_options.length
  )
    throw new Error('CONTRACT_ADMISSION_SELECTED_ROUTE_INVALID')
  const seen = new Set<string>()
  let selected = 0
  for (const route of payload.route_options) {
    if (
      !route ||
      typeof route !== 'object' ||
      Array.isArray(route) ||
      !text(route.id) ||
      seen.has(route.id) ||
      !text(route.evidence) ||
      !text(route.disposition)
    )
      throw new Error('CONTRACT_ADMISSION_ROUTE_OPTION_INVALID')
    seen.add(route.id)
    if (route.disposition === 'SELECTED') {
      selected++
      if (route.id !== payload.selected_route_id)
        throw new Error('CONTRACT_ADMISSION_SELECTED_ROUTE_INVALID')
    }
  }
  if (selected !== 1) throw new Error('CONTRACT_ADMISSION_SELECTED_ROUTE_INVALID')
}
