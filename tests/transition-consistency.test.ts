import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { transition } from '../scripts/controllers/transition.controller'
import { recordEvent } from '../scripts/controllers/record.controller'
import { initLoop } from '../scripts/controllers/init.controller'
import { authBootstrap } from '../scripts/controllers/auth-bootstrap.controller'
import { admissionFixture } from './fixtures/admission'

/** Construct a real authenticated draft; no unsigned admission or phase shortcut. */
function draft(sdd: string) {
  writeFileSync(sdd, admissionFixture().source)
  initLoop(sdd, 4)
  authBootstrap(sdd, 'DISCOVER', 'v1', 'yes', 'token')
  transition(sdd, 'coordinator', 'DISCOVER', 'v1', 'ARCHITECT', 'token')
  transition(sdd, 'coordinator', 'ARCHITECT', 'v1', 'CONTRACT_DRAFT', 'token')
}

test('product phase entries require current admission and cannot skip role evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'transition-admission-'))
  const sdd = join(root, 'sdd.md')
  const state = () => readFileSync(sdd + '.loop.json', 'utf8')
  const events = () => readFileSync(sdd + '.events.jsonl', 'utf8')
  const reject = (from: string, to: string, error: string) => {
    const before = state(),
      log = events()
    expect(() => transition(sdd, 'coordinator', from, 'v1', to, 'token')).toThrow(error)
    expect(state()).toBe(before)
    expect(events()).toBe(log)
  }
  try {
    draft(sdd)
    reject('CONTRACT_DRAFT', 'CONTRACT_ADMITTED', 'CONTRACT_ADMISSION_GATE_MISSING')
    recordEvent(
      sdd,
      'coordinator',
      'CONTRACT_DRAFT',
      'v1',
      'contract_admission',
      admissionFixture().payload,
      'token'
    )
    const admitted = state()
    writeFileSync(
      sdd + '.loop.json',
      JSON.stringify({
        ...JSON.parse(admitted),
        pending_execution_failure: { root_cause_key: 'fixture' }
      })
    )
    reject('CONTRACT_DRAFT', 'CONTRACT_ADMITTED', 'CONTRACT_ADMISSION_AUTHORITY_STALE')
    writeFileSync(sdd + '.loop.json', admitted)
    expect(
      transition(sdd, 'coordinator', 'CONTRACT_DRAFT', 'v1', 'CONTRACT_ADMITTED', 'token').to
    ).toBe('CONTRACT_ADMITTED')
    transition(sdd, 'coordinator', 'CONTRACT_ADMITTED', 'v1', 'OPERATOR_READBACK', 'token')
    reject('OPERATOR_READBACK', 'IMPLEMENTING', 'PHASE_TRANSITION_DENIED')
    reject('OPERATOR_READBACK', 'READBACK_APPROVED', 'ROLE_GATE_MISSING')
    reject('OPERATOR_READBACK', 'BLOCKED', 'TERMINAL_BLOCKER_EVIDENCE_REQUIRED')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('native phase transitions preserve counters and accept subsequent Coordinator records', () => {
  const root = mkdtempSync(join(tmpdir(), 'transition-consistency-'))
  const sdd = join(root, 'sdd.md')
  try {
    draft(sdd)
    const original = JSON.parse(readFileSync(sdd + '.loop.json', 'utf8'))
    const log = readFileSync(sdd + '.events.jsonl', 'utf8')
    for (const patch of [
      { state: 'IMPLEMENTING' },
      { revision: -1 },
      { revision: 1.5 },
      { revision: Number.MAX_SAFE_INTEGER }
    ]) {
      const bytes = JSON.stringify({ ...original, ...patch })
      writeFileSync(sdd + '.loop.json', bytes)
      expect(() =>
        transition(sdd, 'coordinator', 'CONTRACT_DRAFT', 'v1', 'CONTRACT_ADMITTED', 'token')
      ).toThrow()
      expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(bytes)
      expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe(log)
    }
    writeFileSync(sdd + '.loop.json', JSON.stringify(original))
    recordEvent(
      sdd,
      'coordinator',
      'CONTRACT_DRAFT',
      'v1',
      'contract_admission',
      admissionFixture().payload,
      'token'
    )
    transition(sdd, 'coordinator', 'CONTRACT_DRAFT', 'v1', 'CONTRACT_ADMITTED', 'token')
    transition(sdd, 'coordinator', 'CONTRACT_ADMITTED', 'v1', 'OPERATOR_READBACK', 'token')
    recordEvent(
      sdd,
      'coordinator',
      'OPERATOR_READBACK',
      'v1',
      'coordination_note',
      { summary: 'Operator may now read back the admitted route' },
      'token'
    )
    const current = JSON.parse(readFileSync(sdd + '.loop.json', 'utf8'))
    expect(current).toMatchObject({
      phase: 'OPERATOR_READBACK',
      revision: original.revision + 4,
      contract_revision: original.contract_revision,
      authority_epoch: original.authority_epoch,
      requirements: original.requirements,
      completed_attempts: original.completed_attempts
    })
    expect(readFileSync(sdd + '.events.jsonl', 'utf8').startsWith(log)).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
