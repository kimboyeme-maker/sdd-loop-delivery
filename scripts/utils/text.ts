/** Pure text predicates shared by schema and document checks. */
export function isTextList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

export function isNonEmptyTextList(value: unknown): value is string[] {
  return isTextList(value) && value.length > 0 && value.every((item) => item.trim().length > 0)
}
