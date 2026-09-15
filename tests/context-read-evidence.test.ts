import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contextRead } from '../scripts/controllers/read-only.controller'
import { assertContextReadEvidence } from '../scripts/services/context-read-evidence'

test('original context pages must cover the current source completely', () => {
  const root = mkdtempSync(join(tmpdir(), 'context-proof-'))
  const sdd = join(root, 'source.md'),
    proof = join(root, 'read.json')
  try {
    writeFileSync(sdd, '开头\n# Context\n末尾')
    const pages: ReturnType<typeof contextRead>[] = []
    let cursor: number | null = 0
    do {
      const page = contextRead(sdd, cursor, 5)
      pages.push(page)
      cursor = page.nextOffset
    } while (cursor !== null)
    const check = (value: unknown) => {
      writeFileSync(proof, JSON.stringify(value))
      return () => assertContextReadEvidence(sdd, proof)
    }
    expect(check(pages)).not.toThrow()
    expect(check(pages.slice(0, -1))).toThrow('CONTEXT_READ_INCOMPLETE')
    expect(check(pages.slice(1))).toThrow('CONTEXT_READ_EVIDENCE_INVALID')
    expect(check([...pages, pages.at(-1)])).toThrow('CONTEXT_READ_EVIDENCE_INVALID')
    expect(check(pages.map((p, i) => (i === 0 ? { ...p, sha256: 'fixture' } : p)))).toThrow(
      'CONTEXT_READ_SOURCE_MISMATCH'
    )
    expect(
      check({ end_marker: 'CONTEXT_PAGE_COMPLETE', next_cursor: null, read_receipts: [] })
    ).toThrow('CONTEXT_READ_EVIDENCE_INVALID')
    writeFileSync(sdd, 'changed source')
    expect(check(pages)).toThrow()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
