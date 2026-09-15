import { workspacePath } from '../../utils/workspace-path'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { join, relative } from 'node:path'

/** Keep additional Git argv comfortably bounded without changing snapshot coverage. */
const IGNORED_QUERY_MAX_PATHS = 128
const IGNORED_QUERY_MAX_BYTES = 32 * 1024

/** Never follow a replaced ancestor into files outside the captured worktree. */
function hasDirectoryAncestors(root: string, path: string): boolean {
  const parts = path.split('/')
  let current = root
  for (const part of parts.slice(0, -1)) {
    current = join(current, part)
    try {
      if (!lstatSync(current).isDirectory()) return false
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code)))
        return false
      throw error
    }
  }
  return true
}

/** Symlink contents describe a link, never an authoritative local package manifest. */
function isRegularManifest(path: string): boolean {
  return existsSync(path) && lstatSync(path).isFile()
}

export type WorktreeSnapshot = Readonly<{
  protocol: 'worktree-view/v1'
  root: string
  head: string | null
  changes: readonly string[]
  fingerprint: string
  files: readonly {
    path: string
    kind: 'file' | 'symlink' | 'missing' | 'directory'
    mode: number
    sha256: string
  }[]
  owners: readonly {
    root: string
    identity: string
    manifest: 'package.json' | 'go.mod' | 'Cargo.toml'
  }[]
}>

export function owners(root: string): readonly {
  root: string
  identity: string
  manifest: 'package.json' | 'go.mod' | 'Cargo.toml'
}[] {
  const result: {
    root: string
    identity: string
    manifest: 'package.json' | 'go.mod' | 'Cargo.toml'
  }[] = []
  const inspect = (directory: string): void => {
    const packageFile = join(directory, 'package.json')
    if (isRegularManifest(packageFile)) {
      try {
        const pkg = JSON.parse(readFileSync(packageFile, 'utf8')) as { name?: unknown }
        if (typeof pkg.name === 'string' && pkg.name)
          result.push({
            root: relative(root, directory) || '.',
            identity: pkg.name,
            manifest: 'package.json'
          })
      } catch {
        /* malformed manifests are reported by the caller's normal checks */
      }
    }
    const cargoFile = join(directory, 'Cargo.toml')
    if (isRegularManifest(cargoFile)) {
      try {
        const document = Bun.TOML.parse(readFileSync(cargoFile, 'utf8')) as {
          package?: { name?: unknown }
        }
        const name = document.package?.name
        if (typeof name === 'string' && name.trim())
          result.push({
            root: relative(root, directory) || '.',
            identity: name,
            manifest: 'Cargo.toml'
          })
      } catch {
        /* A malformed manifest cannot establish an owner alias. */
      }
    }
    const goFile = join(directory, 'go.mod')
    if (isRegularManifest(goFile)) {
      // A module directive is line-oriented; dependency names never define ownership.
      const matches = [
        ...readFileSync(goFile, 'utf8').matchAll(
          /^\s*module[ \t]+(?:"([^"\r\n]+)"|([^\s]+))[ \t]*(?:\/\/[^\r\n]*)?$/gm
        )
      ]
      if (matches.length === 1)
        result.push({
          root: relative(root, directory) || '.',
          identity: matches[0]![1] ?? matches[0]![2]!,
          manifest: 'go.mod'
        })
    }
  }
  const scan = (directory: string): void => {
    inspect(directory)
    for (const name of readdirSync(directory)) {
      if (['node_modules', '.git'].includes(name)) continue
      const child = join(directory, name)
      if (!existsSync(child) || !lstatSync(child).isDirectory()) continue
      scan(child)
    }
  }
  scan(root)
  return result
}

/** Read actual git facts; this helper never writes, stages, or resets files. */
export function snapshotWorktree(
  root: string,
  excludedPaths: readonly string[] = [],
  generatedPaths: readonly string[] = []
): WorktreeSnapshot {
  const run = (args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
    if (result.exitCode !== 0)
      throw new Error(result.stderr.toString().trim() || 'WORKTREE_READ_FAILED')
    return result.stdout.toString()
  }
  const headResult = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const head = headResult.exitCode === 0 ? headResult.stdout.toString().trim() : null
  const changes = run(['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    .split('\0')
    .filter(Boolean)
  const ownership = owners(root)
  // Git status names changes but does not describe their bytes. Include tracked
  // and non-ignored untracked entries, retaining deletions and dangling symlinks.
  // Explicit generated roots remain evidence even when Git ignores their files.
  const listed = new Set(
    run(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
      .split('\0')
      .filter(Boolean)
  )
  const generated = [...new Set(generatedPaths.map(workspacePath))].filter(
    (path) => !listed.has(path)
  )
  // Bound argv bytes and path count. Ordinary baseline files already listed by Git
  // need no second lookup; ignored paths still contribute exactly the same bytes.
  let batch: string[] = [],
    batchBytes = 0
  const flush = () => {
    if (!batch.length) return
    for (const path of run([
      'ls-files',
      '-z',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--',
      ...batch
    ])
      .split('\0')
      .filter(Boolean))
      listed.add(path)
    batch = []
    batchBytes = 0
  }
  for (const path of generated) {
    const argument = `:(literal)${path}`
    const bytes = Buffer.byteLength(argument) + 1
    if (batch.length >= IGNORED_QUERY_MAX_PATHS || batchBytes + bytes > IGNORED_QUERY_MAX_BYTES)
      flush()
    batch.push(argument)
    batchBytes += bytes
  }
  flush()
  const paths = [...listed].sort()
  const files: WorktreeSnapshot['files'] = paths
    .filter((path) => !excludedPaths.includes(path))
    .map((path) => {
      // Git's index can still name children of a directory replaced by a file
      // or symlink. Those old children are missing, not files behind the link.
      if (!hasDirectoryAncestors(root, path)) return { path, kind: 'missing', mode: 0, sha256: '' }
      const absolute = join(root, path)
      let stat
      try {
        stat = lstatSync(absolute)
      } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code)))
          return { path, kind: 'missing', mode: 0, sha256: '' }
        throw error
      }
      const mode = stat.mode & 0o777
      if (stat.isSymbolicLink())
        return {
          path,
          kind: 'symlink',
          mode,
          sha256: createHash('sha256')
            .update(readlinkSync(absolute, { encoding: 'buffer' }))
            .digest('hex')
        }
      if (stat.isFile()) {
        const bytes = readFileSync(absolute)
        const after = lstatSync(absolute)
        // A write racing the capture would bind a mixture of old and new bytes.
        if (
          !after.isFile() ||
          after.ino !== stat.ino ||
          after.size !== stat.size ||
          after.mtimeMs !== stat.mtimeMs ||
          bytes.length !== stat.size
        )
          throw new Error(`WORKTREE_CHANGED_DURING_CAPTURE: ${path}`)
        return {
          path,
          kind: 'file',
          mode,
          sha256: createHash('sha256').update(bytes).digest('hex')
        }
      }
      if (stat.isDirectory())
        return { path, kind: 'directory', mode, sha256: snapshotWorktree(absolute).fingerprint }
      throw new Error(`WORKTREE_FILE_TYPE_UNSUPPORTED: ${path}`)
    })
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        head,
        files,
        index: run(['ls-files', '--stage', '-z']),
        owners: ownership
      })
    )
    .digest('hex')
  return {
    protocol: 'worktree-view/v1',
    root,
    head,
    changes,
    files,
    fingerprint,
    owners: ownership
  }
}
