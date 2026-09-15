/** Build a stable key for a source fragment and its applicability scope. */
export function contextKey(source: string, section: string, scope: string): string {
  if (!source || !section || !scope) throw new Error('CONTEXT_KEY_FIELDS_REQUIRED')
  return `${source}\u001f${section}\u001f${scope}`
}
