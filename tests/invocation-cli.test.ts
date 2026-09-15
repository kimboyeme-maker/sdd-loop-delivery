import { rolePublicKey } from '../scripts/resource/role-signature'
import { expect, test } from 'bun:test'
import { createHash, createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('CLI carries invocation correlation across commands without sharing command identity or bypassing authentication', () => {
  const root = mkdtempSync(join(tmpdir(), 'invocation-cli-')),
    sdd = join(root, 'sdd.md')
  const metadata = JSON.stringify({
    protocol: 'skill-invocation/v1',
    invocation_id: 'same-invocation',
    started_at: '2026-09-13T00:00:00Z',
    origin: 'explicit'
  })
  try {
    writeFileSync(sdd, '# fixture')
    writeFileSync(
      sdd + '.loop.json',
      JSON.stringify({
        protocol: 'control-plane/state-v2',
        sdd_fingerprint: createHash('sha256').update('# fixture').digest('hex'),
        phase: 'DISCOVER',
        revision: 1,
        authority_epoch: 1,
        coordinator_agent_id: 'coordinator',
        coordinator_event_keys: { '1': rolePublicKey('token') },
        contract_revision: 'v1',
        coordinator_token_hash: createHash('sha256').update('token').digest('hex')
      })
    )
    writeFileSync(sdd + '.events.jsonl', '')
    const run = (input: string, token = 'token') =>
      Bun.spawnSync(
        [
          process.execPath,
          join(import.meta.dir, '../scripts/main.ts'),
          'record',
          '--sdd',
          sdd,
          '--role',
          'coordinator',
          '--expected-state',
          'DISCOVER',
          '--expected-revision',
          'v1',
          '--type',
          'coordination_note',
          '--payload-json',
          '{}'
        ],
        {
          env: {
            ...process.env,
            SDD_INVOCATION_METADATA: input,
            SDD_LOOP_COORDINATOR_TOKEN: token
          }
        }
      )
    expect(run(metadata).exitCode).toBe(0)
    expect(run(metadata).exitCode).toBe(0)
    const bytes = readFileSync(sdd + '.events.jsonl', 'utf8')
    const events = bytes
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(events.map((event) => event.context.invocation_id)).toEqual([
      'same-invocation',
      'same-invocation'
    ])
    expect(events[0].context.command_id).not.toBe(events[1].context.command_id)
    for (const { signature, ...body } of events)
      expect(signature).toBe(
        createHmac('sha256', 'token').update(JSON.stringify(body)).digest('hex')
      )
    const state = readFileSync(sdd + '.loop.json', 'utf8')
    expect(run('malformed').exitCode).toBe(2)
    expect(run(metadata, 'wrong-token').exitCode).toBe(1)
    expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(state)
    expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe(bytes)
    const transitioned = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, '../scripts/main.ts'),
        'transition',
        '--sdd',
        sdd,
        '--role',
        'coordinator',
        '--expected-state',
        'DISCOVER',
        '--expected-revision',
        'v1',
        '--to',
        'ARCHITECT'
      ],
      {
        env: {
          ...process.env,
          SDD_INVOCATION_METADATA: metadata,
          SDD_LOOP_COORDINATOR_TOKEN: 'token'
        }
      }
    )
    expect(transitioned.exitCode).toBe(0)
    const { signature, ...body } = JSON.parse(
      readFileSync(sdd + '.events.jsonl', 'utf8')
        .trim()
        .split('\n')
        .at(-1)!
    )
    expect(body.context.invocation_id).toBe('same-invocation')
    expect(body.context.command_id).not.toBe(events[1].context.command_id)
    expect(signature).toBe(createHmac('sha256', 'token').update(JSON.stringify(body)).digest('hex'))
    const observation = join(root, 'observation.json')
    writeFileSync(
      observation,
      JSON.stringify({
        id: 'observation-1',
        controller: sdd,
        coordinator_agent_id: 'coordinator',
        authority_epoch: 1,
        previous_record_id: null,
        agent_role: 'operator',
        host: {
          model: 'gpt-5.6-terra',
          reasoning_effort: 'medium',
          status: 'idle',
          controllable: true,
          writer_stopped: true,
          commands_stopped: true,
          close_available: false,
          conversation_id: 'isolated',
          ancestor_ids: ['coordinator'],
          confirmed_by: 'coordinator'
        },
        agent_id: '/root/operator',
        action: 'observe',
        evidence: 'host reports idle'
      })
    )
    const observe = () =>
      Bun.spawnSync(
        [
          process.execPath,
          join(import.meta.dir, '../scripts/main.ts'),
          'runtime-record',
          '--sdd',
          sdd,
          '--role',
          'coordinator',
          '--expected-state',
          'ARCHITECT',
          '--expected-revision',
          'v1',
          '--payload-file',
          observation
        ],
        {
          env: {
            ...process.env,
            SDD_INVOCATION_METADATA: metadata,
            SDD_LOOP_COORDINATOR_TOKEN: 'token'
          }
        }
      )
    const firstObservation = observe()
    expect(firstObservation.exitCode).toBe(0)
    const observedEvents = readFileSync(sdd + '.events.jsonl', 'utf8'),
      observedState = readFileSync(sdd + '.loop.json', 'utf8')
    const repeatedObservation = observe()
    expect(repeatedObservation.exitCode).toBe(0)
    expect(JSON.parse(repeatedObservation.stdout.toString()).eventId).toBe(
      JSON.parse(firstObservation.stdout.toString()).eventId
    )
    expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe(observedEvents)
    expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(observedState)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
