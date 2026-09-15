/** Validate the persisted counter before incrementing; coercion or overflow loses ordering. */
export function nextControlRevision(revision: unknown, increment = 1): number {
  if (!Number.isSafeInteger(increment) || increment < 1)
    throw new Error('CONTROL_REVISION_INCREMENT_INVALID')
  if (
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    revision > Number.MAX_SAFE_INTEGER - increment
  )
    throw new Error('CONTROL_REVISION_INVALID')
  return revision + increment
}
