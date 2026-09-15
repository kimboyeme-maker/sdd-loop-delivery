import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync
} from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { normalizeOwner } from '../domain/policies/scope'
import { owners } from '../resource/worktree/snapshot'

/** Directories never scanned as observed package files: VCS metadata and installed trees. */
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules'])
/** Dependency locks recorded with observed packages at the package and repository roots. */
const LOCKFILES = [
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'Cargo.lock',
  'go.sum',
  'uv.lock',
  'poetry.lock',
  'Gemfile.lock'
]

type InputFile = Readonly<{ path: string; kind: 'file' | 'symlink'; mode: number; sha256: string }>

/**
 * Resolve declared packages (repository roots or manifest identities such as `@scope/foo`) to
 * existing repository-relative roots through the repository's owner mapping. An unresolvable
 * declaration is an error, never an empty input set.
 */
export function resolvePackageRoots(root: string, packages: readonly string[]): string[] {
  const mappings = owners(root)
  return [...new Set(packages)].sort().map((name) => {
    if (name === '.') return '.'
    const resolved = normalizeOwner(name, mappings)
    if (
      isAbsolute(resolved) ||
      resolved.split('/').includes('..') ||
      !existsSync(join(root, resolved))
    )
      throw new Error(`TEST_RUN_PACKAGE_UNRESOLVED: ${name}`)
    return resolved
  })
}

/** Files under resolved package roots plus lockfiles; symlinks are recorded by their link text. */
function packageInputFiles(root: string, roots: readonly string[]): InputFile[] {
  const files = new Map<string, InputFile>()
  const add = (absolute: string) => {
    const stat = lstatSync(absolute)
    const path = relative(root, absolute).split(sep).join('/')
    if (stat.isSymbolicLink())
      files.set(path, {
        path,
        kind: 'symlink',
        mode: stat.mode & 0o7777,
        sha256: createHash('sha256').update(readlinkSync(absolute)).digest('hex')
      })
    else if (stat.isFile())
      files.set(path, {
        path,
        kind: 'file',
        mode: stat.mode & 0o7777,
        sha256: createHash('sha256').update(readFileSync(absolute)).digest('hex')
      })
    else if (stat.isDirectory())
      for (const name of readdirSync(absolute))
        if (!SKIPPED_DIRECTORIES.has(name)) add(join(absolute, name))
  }
  for (const name of roots) {
    const packageRoot = name === '.' ? root : join(root, name)
    if (!existsSync(packageRoot)) throw new Error(`TEST_RUN_PACKAGE_UNRESOLVED: ${name}`)
    add(packageRoot)
    for (const directory of new Set([root, packageRoot]))
      for (const lock of LOCKFILES)
        if (existsSync(join(directory, lock))) add(join(directory, lock))
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path))
}

/** First path whose presence or bytes differ between two sorted file lists, for a precise error. */
function firstDifference(left: readonly unknown[], right: readonly unknown[]): string {
  const key = (item: unknown) => JSON.stringify(item)
  const rightKeys = new Set(right.map(key))
  const leftKeys = new Set(left.map(key))
  const differing = [
    ...left.filter((item) => !rightKeys.has(key(item))),
    ...right.filter((item) => !leftKeys.has(key(item)))
  ]
  if (differing.length) return String((differing[0] as { path?: unknown }).path)
  const index = left.findIndex((item, position) => key(item) !== key(right[position]))
  return `${String((left[index] as { path?: unknown } | undefined)?.path ?? 'end')} (${left.length} vs ${right.length})`
}

const fingerprint = (files: readonly unknown[]): string =>
  createHash('sha256').update(JSON.stringify(files)).digest('hex')

/** True when `inner` is `outer` or lies inside it, comparing real paths so aliases cannot hide it. */
export function containsPath(outer: string, inner: string): boolean {
  const a = realpathSync(outer)
  const b = realpathSync(inner)
  return b === a || b.startsWith(a.endsWith(sep) ? a : a + sep)
}

export type ExecutionInputs = Readonly<{
  protocol: 'execution-inputs/v1'
  candidate_event_id: string | null
  source_root: string | null
  packages: string[]
  files_fingerprint: string
  file_count: number
}>

/**
 * Freeze what a run executes against, before it starts: the candidate, the resolved observed
 * packages and their files in the run directory, which for a copy must equal the product bytes.
 * The record proves what this run observed; results are never reused by another run.
 */
export function freezeExecutionInputs(
  input: Readonly<{
    directory: string
    sourceRoot: string | null
    packages: readonly string[]
    candidateEventId: string | null
  }>
): ExecutionInputs {
  const base = input.sourceRoot ?? input.directory
  const roots = resolvePackageRoots(base, input.packages)
  const files = packageInputFiles(input.directory, roots)
  const copied =
    input.sourceRoot !== null && realpathSync(input.sourceRoot) !== realpathSync(input.directory)
  if (copied) {
    const source = packageInputFiles(input.sourceRoot!, roots)
    if (fingerprint(source) !== fingerprint(files))
      throw new Error(`TEST_RUN_COPY_DIVERGED: ${firstDifference(source, files)}`)
  }
  return {
    protocol: 'execution-inputs/v1',
    candidate_event_id: input.candidateEventId,
    source_root: input.sourceRoot ? realpathSync(input.sourceRoot) : null,
    packages: roots,
    files_fingerprint: fingerprint(files),
    file_count: files.length
  }
}
