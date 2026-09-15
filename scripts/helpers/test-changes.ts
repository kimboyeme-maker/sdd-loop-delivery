import { assertTestFileName, testArtifact } from '../domain/policies/test-naming'

type Item = Record<string, unknown>
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
const list = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every(text)
/** New-file naming applies only to CREATED. Existing files still need frozen baseline proof.
 * The delta is returned by the actual worktree check, never reconstructed from Git HEAD
 * or trusted from a role's manifest. Renames therefore appear as deletion plus creation.
 */
export function assertTestChanges(
  value: unknown,
  baselinePaths: ReadonlySet<string>,
  delta: ReadonlyMap<string, string>
): void {
  if (!Array.isArray(value)) throw new Error('IMPLEMENTATION_TEST_CHANGES_REQUIRED')
  const paths = new Set<string>(),
    concepts = new Set<string>(),
    changed = new Set<string>()
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('IMPLEMENTATION_TEST_CHANGE_INVALID')
    const item = entry as Item
    if (
      !text(item.path) ||
      paths.has(item.path) ||
      !text(item.business_concept) ||
      !text(item.business_oracle) ||
      !['REUSED', 'MODIFIED', 'CREATED', 'DELETED'].includes(String(item.action)) ||
      !['UNIT', 'INTEGRATION', 'BROWSER', 'PACKED_CONSUMER', 'E2E'].includes(String(item.layer)) ||
      !list(item.requirement_ids) ||
      !list(item.acceptance_ids)
    )
      throw new Error('IMPLEMENTATION_TEST_CHANGE_INVALID')
    const path = item.path
    paths.add(path)
    const info = testArtifact(path)
    if (!info.recognized) throw new Error('TEST_FILE_SUFFIX_UNRECOGNIZED')
    if (
      item.action === 'DELETED' &&
      (!text(item.deletion_reason) || !text(item.replacement_oracle))
    )
      throw new Error('DELETED_TEST_ORACLE_DISPOSITION_REQUIRED')
    if (item.action === 'CREATED') {
      assertTestFileName(path)
      if (
        !list(item.reuse_candidates) ||
        !['TEST_LAYER', 'RUNTIME', 'ISOLATION', 'REPOSITORY_MODULE'].includes(
          String(item.separation_boundary)
        ) ||
        !text(item.separation_reason)
      )
        throw new Error('CREATED_TEST_FILE_JUSTIFICATION_REQUIRED')
      const key = JSON.stringify([
        item.business_concept.toLowerCase().trim().replace(/\s+/g, ' '),
        item.layer
      ])
      if (concepts.has(key)) throw new Error('DUPLICATE_CREATED_TEST_CONCEPT_LAYER')
      concepts.add(key)
    }
    const before = baselinePaths.has(path),
      action = delta.get(path)
    if (
      item.action === 'REUSED'
        ? !before || action !== undefined
        : item.action === 'CREATED'
          ? before || action !== 'CREATED'
          : !before || action !== item.action
    )
      throw new Error('TEST_FILE_ACTION_BASELINE_MISMATCH')
    if (item.action !== 'REUSED') changed.add(path)
  }
  const actual = [...delta.keys()].filter((path) => testArtifact(path).recognized)
  if (actual.length !== changed.size || actual.some((path) => !changed.has(path)))
    throw new Error('IMPLEMENTATION_TEST_CHANGES_INCOMPLETE')
}
