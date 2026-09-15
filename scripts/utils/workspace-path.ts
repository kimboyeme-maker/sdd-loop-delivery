/** Normalize a relative manifest path without resolving away traversal evidence. */
export function workspacePath(value: string): string {
  const path = value.replaceAll('\\', '/')
  if (
    !path ||
    path.includes('\0') ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    path.split('/').includes('..')
  )
    throw new Error('WORKSPACE_PATH_INVALID')
  const normalized = path
    .split('/')
    .filter((part) => part !== '' && part !== '.')
    .join('/')
  if (!normalized) throw new Error('WORKSPACE_PATH_INVALID')
  return normalized
}
