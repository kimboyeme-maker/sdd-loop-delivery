/**
 * Runtime identities are opaque host values, not workspace paths or local slugs.
 * Preserve exact bytes for receipt/history matching; never trim, case-fold or
 * normalize a task path. Syntax validity is not proof of host ownership.
 */
export function isRuntimeIdentity(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || /\s/u.test(value)) return false
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code < 32 || code === 127) return false
  }
  return true
}
