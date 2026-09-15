export type FindingStatus = 'open' | 'resolved'

export type FindingRecord = Readonly<{
  id: string
  status: FindingStatus
  priority: 'P0' | 'P1' | 'P2' | 'P3'
  evidenceId: string
  candidateId: string
  affectedRequirements: readonly string[]
  reverifyRequired: boolean
}>

/** A Finding is evidence-bound work; its resolution cannot erase its identity. */
export function assertFinding(record: FindingRecord): void {
  if (!record.id || !record.evidenceId || !record.candidateId)
    throw new Error('FINDING_BINDING_REQUIRED')
  if (record.affectedRequirements.length === 0) throw new Error('FINDING_REQUIREMENTS_REQUIRED')
  if (record.status === 'resolved' && record.reverifyRequired)
    throw new Error('FINDING_REVERIFY_REQUIRED')
}

export function resolveFinding(record: FindingRecord, reverifyEvidenceId: string): FindingRecord {
  assertFinding(record)
  if (record.status !== 'open') throw new Error('FINDING_ALREADY_RESOLVED')
  if (!reverifyEvidenceId) throw new Error('FINDING_REVERIFY_EVIDENCE_REQUIRED')
  return Object.freeze({ ...record, status: 'resolved', reverifyRequired: false })
}
