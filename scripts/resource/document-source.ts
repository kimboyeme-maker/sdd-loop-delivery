import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, basename, extname, isAbsolute, join, resolve } from 'node:path'

/** Resolve existing ancestors so virtual draft paths cannot hide a symlink escape. */
function canonicalPath(path: string): string {
  const absolute = resolve(path)
  if (existsSync(absolute)) return realpathSync(absolute)
  const parent = dirname(absolute)
  return parent === absolute ? absolute : join(canonicalPath(parent), basename(absolute))
}

/** Per-call Markdown overlay; never writes draft files or persists global input state. */
export function documentSource(documents: readonly { path: string; content: string }[] = []) {
  const overlay = new Map<string, string>()
  for (const entry of documents) {
    if (
      !entry ||
      Object.keys(entry).sort().join() !== 'content,path' ||
      typeof entry.path !== 'string' ||
      !isAbsolute(entry.path) ||
      extname(entry.path).toLowerCase() !== '.md' ||
      typeof entry.content !== 'string'
    )
      throw Error('DRAFT_DOCUMENT_INVALID')
    const path = canonicalPath(entry.path)
    if (overlay.has(path)) throw Error('DRAFT_DOCUMENT_DUPLICATE')
    overlay.set(path, entry.content)
  }
  return {
    canonical: canonicalPath,
    read(path: string): Buffer {
      const key = canonicalPath(path)
      return overlay.has(key) ? Buffer.from(overlay.get(key)!) : readFileSync(key)
    },
    isFile(path: string): boolean {
      const key = canonicalPath(path)
      return overlay.has(key) || (existsSync(key) && statSync(key).isFile())
    }
  }
}
