import { test, expect } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attempt } from '../scripts/controllers/attempt.controller'

test('attempt rejects corrupted budgets without writes and preserves valid accounting', () => {
  const root = mkdtempSync(join(tmpdir(), 'attempt-counts-')),
    sdd = join(root, 'task.md')
  const base = {
    protocol: 'control-plane/state-v2',
    phase: 'COORDINATOR_TRIAGE',
    revision: 1,
    contract_revision: 'v1',
    coordinator_token_hash: createHash('sha256').update('token').digest('hex'),
    max_rounds: 6,
    round_completed_attempts: 1,
    completed_attempts: 3,
    consecutive_stagnant_attempts: 1,
    requirements: { XQ01: 'pending' }
  }
  const run = () => attempt(sdd, 'coordinator', 'COORDINATOR_TRIAGE', 'v1', 'stagnant', 'token')
  try {
    for (const field of [
      'max_rounds',
      'round_completed_attempts',
      'completed_attempts',
      'consecutive_stagnant_attempts'
    ]) {
      for (const value of [null, '2', false, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        const bytes = JSON.stringify({ ...base, [field]: value })
        writeFileSync(sdd + '.loop.json', bytes)
        writeFileSync(sdd + '.events.jsonl', '')
        expect(run).toThrow('ATTEMPT_COUNTER_INVALID')
        expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(bytes)
        expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe('')
      }
    }
    writeFileSync(sdd + '.loop.json', JSON.stringify(base))
    expect(run().attempt).toBe(2)
    expect(JSON.parse(readFileSync(sdd + '.loop.json', 'utf8'))).toMatchObject({
      revision: 2,
      completed_attempts: 4,
      round_completed_attempts: 2,
      consecutive_stagnant_attempts: 2,
      requirements: base.requirements
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
