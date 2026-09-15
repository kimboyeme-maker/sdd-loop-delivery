import { admissionFixture } from './fixtures/admission'
import { recordEvent } from '../scripts/controllers/record.controller'
import { rolePublicKey } from '../scripts/resource/role-signature'
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepare } from '../scripts/controllers/prepare.controller'
import { prepareRecord } from '../scripts/controllers/prepare-record.controller'

test('preparation survives phase advancement but rejects source and authority drift without writes', () => {
  const root = mkdtempSync(join(tmpdir(), 'preparation-binding-')),
    sdd = join(root, 'sdd.md')
  const saved = [process.env.SDD_LOOP_AGENT_TOKEN_FILE, process.env.SDD_LOOP_CAPABILITY_DIR]
  process.env.SDD_LOOP_CAPABILITY_DIR = join(root, 'capabilities')
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const source = admissionFixture().source
  try {
    writeFileSync(sdd, source)
    writeFileSync(
      sdd + '.loop.json',
      JSON.stringify({
        protocol: 'control-plane/state-v2',
        sdd_fingerprint: hash(source),
        phase: 'CONTRACT_DRAFT',
        revision: 1,
        contract_revision: 'v1',
        authority_epoch: 2,
        coordinator_event_keys: { '2': rolePublicKey('coordinator') },
        coordinator_token_hash: hash('coordinator')
      })
    )
    writeFileSync(sdd + '.events.jsonl', '')
    recordEvent(
      sdd,
      'coordinator',
      'CONTRACT_DRAFT',
      'v1',
      'contract_admission',
      admissionFixture().payload,
      'coordinator'
    )
    // Lifecycle fixture: admission is genuine; Operator progress itself is outside this test.
    const admitted = JSON.parse(readFileSync(sdd + '.loop.json', 'utf8'))
    const operatorLease = {
      role: 'operator',
      lease_id: 'op',
      agent_id: 'operator',
      authority_epoch: 2,
      contract_revision: 'v1',
      issued_at: new Date().toISOString(),
      hard_deadline_minutes: 5
    }
    writeFileSync(
      sdd + '.loop.json',
      JSON.stringify({
        ...admitted,
        phase: 'IMPLEMENTING',
        active_lease: operatorLease,
        issued_leases: { op: operatorLease }
      })
    )
    const initial = readFileSync(sdd + '.loop.json')
    expect(() =>
      prepare(sdd, 'coordinator', 'IMPLEMENTING', 'v1', 'operator', false, false, 'coordinator')
    ).toThrow('PREPARE_ROLE_IDENTITY_CONFLICT')
    expect(readFileSync(sdd + '.loop.json')).toEqual(initial)
    const expired = JSON.parse(initial.toString())
    expired.active_lease.issued_at = '2000-01-01T00:00:00Z'
    writeFileSync(sdd + '.loop.json', JSON.stringify(expired))
    expect(() =>
      prepare(sdd, 'coordinator', 'IMPLEMENTING', 'v1', 'architect', false, false, 'coordinator')
    ).toThrow('AGENT_LEASE_EXPIRED')
    expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(JSON.stringify(expired))
    writeFileSync(sdd + '.loop.json', initial)
    const granted = prepare(
      sdd,
      'coordinator',
      'IMPLEMENTING',
      'v1',
      'architect',
      false,
      false,
      'coordinator'
    )
    // The controller minted the credential; only its locator reaches the Architect runtime.
    expect(granted.capabilityFile).toBeTruthy()
    process.env.SDD_LOOP_AGENT_TOKEN_FILE = granted.capabilityFile
    for (const type of ['implementation', 'self_check', 'verification', 'finding']) {
      const before = readFileSync(sdd + '.loop.json')
      const log = readFileSync(sdd + '.events.jsonl')
      expect(() =>
        prepareRecord(
          sdd,
          'architect',
          granted.preparedId,
          type,
          { result: 'PASS' },
          'IMPLEMENTING',
          'v1',
          'coordinator'
        )
      ).toThrow('PREPARATION_FORBIDS_PRODUCT_EVENT')
      expect(readFileSync(sdd + '.loop.json')).toEqual(before)
      expect(readFileSync(sdd + '.events.jsonl')).toEqual(log)
    }
    const baseline = JSON.parse(readFileSync(sdd + '.loop.json', 'utf8'))
    for (const [patch, changedSource, error] of [
      [{ authority_epoch: 3 }, source, 'CONTRACT_ADMISSION_AUTHORITY_INVALID'],
      [{}, 'changed source', 'SDD_SOURCE_CHANGED_REQUIRES_AMEND'],
      [{ contract_revision: 'v2' }, source, 'CONTRACT_ADMISSION_AUTHORITY_INVALID']
    ] as const) {
      const state = { ...baseline, ...patch }
      writeFileSync(sdd, changedSource)
      writeFileSync(sdd + '.loop.json', JSON.stringify(state))
      const before = readFileSync(sdd + '.loop.json'),
        events = readFileSync(sdd + '.events.jsonl')
      expect(() =>
        prepareRecord(
          sdd,
          'architect',
          granted.preparedId,
          'capability_probe',
          { phase: 'OPEN' },
          'IMPLEMENTING',
          state.contract_revision,
          'coordinator'
        )
      ).toThrow(error)
      expect(readFileSync(sdd + '.loop.json')).toEqual(before)
      expect(readFileSync(sdd + '.events.jsonl')).toEqual(events)
    }
    writeFileSync(sdd, source)
    writeFileSync(
      sdd + '.loop.json',
      JSON.stringify({ ...baseline, phase: 'ARCHITECT_VERIFY', active_lease: null })
    )
    expect(() =>
      prepareRecord(
        sdd,
        'architect',
        granted.preparedId,
        'capability_probe',
        { phase: 'OPEN' },
        'ARCHITECT_VERIFY',
        'v1',
        'coordinator'
      )
    ).not.toThrow()
    expect(
      prepare(sdd, 'coordinator', 'ARCHITECT_VERIFY', 'v1', 'architect', false, true, 'coordinator')
        .cancelled
    ).toBe(true)
    expect(JSON.parse(readFileSync(sdd + '.loop.json', 'utf8')).preparation).toBeNull()
  } finally {
    ;['SDD_LOOP_AGENT_TOKEN_FILE', 'SDD_LOOP_CAPABILITY_DIR'].forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key]
      else process.env[key] = saved[index]
    })
    rmSync(root, { recursive: true, force: true })
  }
})
