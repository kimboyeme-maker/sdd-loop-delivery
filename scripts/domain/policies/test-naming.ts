import { posix } from 'node:path'

const DIRECTORIES = new Set(['test', 'tests', 'spec', 'specs', 'e2e', '__tests__'])
/** Name tokens that describe a test layer or a fix, never the protected behavior. */
const GENERIC = new Set([
  'test',
  'tests',
  'spec',
  'e2e',
  'unit',
  'integration',
  'browser',
  'packed',
  'consumer',
  'patch',
  'hotfix',
  'fix',
  'bug',
  'issue',
  'regression'
])
/** Delivery history in a name: rounds, revisions, packets, attempts, iterations and roles. */
const DELIVERY =
  /(?:^|[-_.])(?:round(?:[-_]?\d+)?|r\d+|rev(?:ision)?[-_]?\d+|(?:pk|pkt|pack|packet)[-_]?\d+|attempt[-_]?\d+|iteration[-_]?\d+|operator|architect|coordinator)(?:$|[-_.])/

/** Recognize native test markers without imposing a language or monorepo layout. */
export function testArtifact(path: string): { stem: string; recognized: boolean } {
  let stem = posix
    .basename(path)
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
  let marked = false
  for (const marker of ['test', 'tests', 'spec', 'e2e']) {
    const suffix = new RegExp(`[._-]${marker}$`),
      prefix = new RegExp(`^${marker}[._-]`)
    if (suffix.test(stem)) {
      stem = stem.replace(suffix, '')
      marked = true
      break
    }
    if (prefix.test(stem)) {
      stem = stem.replace(prefix, '')
      marked = true
      break
    }
  }
  return {
    stem,
    recognized:
      marked ||
      path
        .split('/')
        .slice(0, -1)
        .some((part) => DIRECTORIES.has(part.toLowerCase()))
  }
}

/** A test file is named for the behavior it protects, never for the delivery event that added it. */
export function assertTestFileName(path: string): void {
  const { stem } = testArtifact(path)
  if (DELIVERY.test(stem)) throw new Error('TEST_FILE_DELIVERY_METADATA_NAME_FORBIDDEN')
  if (!stem.split(/[-_.]+/).some((token) => token && !GENERIC.has(token) && !/^\d+$/.test(token)))
    throw new Error('TEST_FILE_BUSINESS_NAME_REQUIRED')
}
