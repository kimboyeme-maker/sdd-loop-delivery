/** Publish scheduling metadata only; never serialize the private lease or baseline wholesale. */
export function publicLease(value: unknown): object | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const lease = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const key of [
    'lease_id',
    'id',
    'agent_id',
    'role',
    'authority_epoch',
    'contract_revision',
    'issued_at',
    'hard_deadline_minutes',
    'dispatch_phase',
    'started_event_id',
    'prepared_id',
    'prepared_event_id',
    'prepared_read_result'
  ]) {
    const field = lease[key]
    if (typeof field === 'string' || (typeof field === 'number' && Number.isFinite(field)))
      result[key] = field
  }
  return result
}
