import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNativeChain } from './fixtures/native-chain'

type Item = Record<string, unknown>
const BINDINGS = [
  'candidate_id',
  'environment_fingerprint',
  'manifest_sha256',
  'worktree_fingerprint'
]

test('a self-check that omits candidate bindings is signed with the current candidate, and a wrong one is still refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'binding-derivation-'))
  const chain = createNativeChain(root)
  try {
    chain.setup()
    chain.admit()
    const lease = chain.readback()
    chain.advance('READBACK_APPROVED', 'IMPLEMENTING')
    chain.implement(lease, 'export const value = 2;')
    chain.advance('OPERATOR_SELF_CHECK')
    chain.runTests(lease)
    const payload = chain.selfCheckPayload()
    const omitted = Object.fromEntries(
      Object.entries(payload).filter(([key]) => !BINDINGS.includes(key))
    )
    expect(() =>
      chain.record('operator', lease, 'self_check', { ...omitted, candidate_id: 'other' })
    ).toThrow('CANDIDATE_RESULT_BINDING_MISMATCH')
    chain.record('operator', lease, 'self_check', omitted)
    const events = readFileSync(chain.sdd + '.events.jsonl', 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Item)
    const signed = events.findLast((event) => event.type === 'self_check')!.payload as Item
    for (const field of BINDINGS) expect(signed[field]).toBe(payload[field])
  } finally {
    chain.restore()
    rmSync(root, { recursive: true, force: true })
  }
})
