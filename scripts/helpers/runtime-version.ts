/**
 * Dotted-version comparison for runtime floors. Used to reject a host runtime older than the
 * controller's minimum before a command reaches a missing runtime behavior.
 */
export function olderThan(version: string, minimum: string): boolean {
  const parts = (value: string) => value.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const [left, right] = [parts(version), parts(minimum)]
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const [a, b] = [left[index] ?? 0, right[index] ?? 0]
    if (a !== b) return a < b
  }
  return false
}
