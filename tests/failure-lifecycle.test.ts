import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { failure } from '../scripts/controllers/failure.controller'

test('pipeline incidents without a lease revoke preparation and preserve product counters', () => {
  const root = mkdtempSync(join(tmpdir(), 'failure-lifecycle-')),
    sdd = join(root, 'sdd.md')
  try {
    writeFileSync(sdd, '# fixture')
    const initial = {
      protocol: 'control-plane/state-v2',
      phase: 'IMPLEMENTING',
      revision: 1,
      contract_revision: 'v1',
      coordinator_token_hash: createHash('sha256').update('token').digest('hex'),
      preparation: { prepared_id: 'prep' },
      total_execution_failures: 4,
      completed_attempts: 5,
      requirements: { XQ01: 'pending' }
    }
    const invalid = JSON.stringify({ ...initial, pipeline_incidents: -1 })
    writeFileSync(sdd + '.loop.json', invalid)
    writeFileSync(sdd + '.events.jsonl', '')
    expect(() =>
      failure(
        'pipeline',
        sdd,
        'coordinator',
        'IMPLEMENTING',
        'v1',
        'operator',
        'host error',
        'host',
        'token'
      )
    ).toThrow('FAILURE_COUNT_INVALID')
    expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(invalid)
    expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe('')
    writeFileSync(sdd + '.loop.json', JSON.stringify(initial))
    failure(
      'pipeline',
      sdd,
      'coordinator',
      'IMPLEMENTING',
      'v1',
      'operator',
      'host error',
      'host',
      'token'
    )
    expect(JSON.parse(readFileSync(sdd + '.loop.json', 'utf8'))).toMatchObject({
      preparation: null,
      active_lease: null,
      total_execution_failures: 4,
      completed_attempts: 5,
      pipeline_incidents: 1,
      phase: 'IMPLEMENTING',
      requirements: initial.requirements
    })
    const before = readFileSync(sdd + '.loop.json', 'utf8'),
      beforeEvents = readFileSync(sdd + '.events.jsonl', 'utf8')
    expect(() =>
      failure(
        'execution',
        sdd,
        'coordinator',
        'IMPLEMENTING',
        'v1',
        'operator',
        'execution error',
        'execution',
        'token'
      )
    ).toThrow('ACTIVE_AGENT_LEASE_REQUIRED')
    expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(before)
    expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe(beforeEvents)
    writeFileSync(
      sdd + '.loop.json',
      JSON.stringify({
        ...JSON.parse(before),
        active_lease: { role: 'operator', lease_id: 'isolated-lease' }
      })
    )
    failure(
      'execution',
      sdd,
      'coordinator',
      'IMPLEMENTING',
      'v1',
      'operator',
      'execution error',
      'execution',
      'token'
    )
    expect(JSON.parse(readFileSync(sdd + '.loop.json', 'utf8'))).toMatchObject({
      phase: 'CONTRACT_DRAFT',
      total_execution_failures: 5,
      pipeline_incidents: 1
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
