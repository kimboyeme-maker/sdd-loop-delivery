export type Readback = Readonly<{
  role: 'Operator' | 'Architect' | 'Coordinator'
  guidanceId: string
  objective: string
  nextAction: string
  checkMethod: string
  stopCondition: string
}>

/** Readback confirms receipt of current guidance; it never proves execution. */
export function assertReadback(
  readback: Readback,
  expectedRole: Readback['role'],
  expectedGuidanceId: string
): void {
  if (readback.role !== expectedRole) throw new Error('READBACK_ROLE_MISMATCH')
  if (readback.guidanceId !== expectedGuidanceId) throw new Error('READBACK_GUIDANCE_MISMATCH')
  for (const [field, value] of Object.entries(readback)) {
    if (field !== 'role' && (typeof value !== 'string' || value.trim() === ''))
      throw new Error('READBACK_FIELD_REQUIRED')
  }
}
