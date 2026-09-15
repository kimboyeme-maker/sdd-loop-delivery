import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { operatorReconcile } from '../scripts/controllers/operator-reconcile.controller'
import { leaseWorktreeFingerprint } from '../scripts/helpers/worktree-candidate'
import { COORDINATOR, createNativeChain } from './fixtures/native-chain'

type Item = Record<string, unknown>

test('Operator returns are reconciled from host facts and a replacement must read back preserved work', () => {
  const root = mkdtempSync(join(tmpdir(), 'operator-recovery-'))
  const chain = createNativeChain(root)
  const persisted = () => [
    readFileSync(chain.sdd + '.loop.json', 'utf8'),
    readFileSync(chain.sdd + '.events.jsonl', 'utf8')
  ]
  try {
    chain.setup()
    chain.admit()
    const leaseId = chain.readback()
    const lease = () => chain.state().active_lease as Item
    writeFileSync(join(chain.workspace, 'value.ts'), 'export const value = 3; // partial')
    const observe = (patch: Item) => ({
      observation_id: 'OBS-1',
      disposition: 'continue',
      worktree_fingerprint: leaseWorktreeFingerprint(chain.sdd, lease()),
      host: {
        runtime_status: 'healthy',
        writer_stopped: false,
        commands_stopped: false,
        evidence: 'host returned idle'
      },
      unfinished: ['return two'],
      next_action: 'finish the value producer',
      reason: 'response ended before the observable outcome',
      ...patch
    })
    const reconcile = (observation: Item, id = leaseId) =>
      operatorReconcile(chain.sdd, chain.phase(), 'v1', id, 'operator', observation, COORDINATOR)
    const rejects = (observation: Item, code: string) => {
      const before = persisted()
      expect(() => reconcile(observation)).toThrow(code)
      expect(persisted()).toEqual(before)
    }

    rejects(observe({ worktree_fingerprint: 'stale' }), 'OPERATOR_OBSERVATION_WORKTREE_STALE')
    rejects(observe({ host: { runtime_status: 'healthy' } }), 'OPERATOR_HOST_OBSERVATION_INVALID')
    rejects(observe({ unfinished: [] }), 'OPERATOR_CONTINUE_REQUIRES_HEALTHY_UNFINISHED_RUNTIME')
    const first = reconcile(observe({ no_progress: true }))
    expect(chain.state().active_lease).not.toBeNull()
    // Same ID and content is idempotent; changed content under that ID is a conflict.
    expect(reconcile(observe({ no_progress: true })).eventId).toBe(first.eventId)
    rejects(observe({ next_action: 'something else' }), 'OPERATOR_OBSERVATION_ID_CONFLICT')
    // Repeated no progress for the same work needs a concrete diagnosis.
    rejects(
      observe({ observation_id: 'OBS-2', no_progress: true }),
      'OPERATOR_REPEATED_NO_PROGRESS_DIAGNOSIS_REQUIRED'
    )
    const diagnosis = {
      dispatch_prompt: 'guidance omitted the check',
      last_tool_result: 'editor stopped mid-change',
      host_state: 'idle',
      diff_review: 'value.ts partially edited'
    }
    rejects(
      observe({ observation_id: 'OBS-3', disposition: 'replace', diagnosis }),
      'OPERATOR_REPLACE_WRITER_STOP_REQUIRED'
    )
    const stopped = {
      runtime_status: 'stopped',
      writer_stopped: true,
      commands_stopped: true,
      evidence: 'host stopped'
    }
    rejects(
      // An earlier no-progress record for this work also makes replacement need a diagnosis.
      observe({ observation_id: 'OBS-3', disposition: 'replace', host: stopped }),
      'OPERATOR_REPLACE_DIAGNOSIS_REQUIRED'
    )
    reconcile(
      observe({ observation_id: 'OBS-3', disposition: 'replace', host: stopped, diagnosis })
    )
    expect(chain.state().active_lease).toBeNull()
    expect(chain.state().operator_recovery).toMatchObject({
      lease_id: leaseId,
      next_action: 'finish the value producer'
    })
    expect(readFileSync(join(chain.workspace, 'value.ts'), 'utf8')).toContain('partial')

    // The successor cannot start without reading back the preserved work.
    const before = persisted()
    expect(() => chain.start('operator', undefined, ['.'], 'operator-2')).toThrow(
      'RECOVERY_READBACK_INVALID'
    )
    const successor = lease()
    expect(successor.recovery).toMatchObject({ source: 'replacement', lease_id: leaseId })
    writeFileSync(chain.sdd + '.loop.json', before[0]!)
    writeFileSync(chain.sdd + '.events.jsonl', before[1]!)
    const readback = (patch: Item = {}) => ({
      recoveryReadback: {
        predecessor_lease_id: leaseId,
        worktree_fingerprint: leaseWorktreeFingerprint(chain.sdd, { ...successor }),
        inspected_paths: ['value.ts'],
        next_action: 'finish the value producer',
        summary: 'Partial value edit preserved; finish it and rerun the check.',
        ...patch
      }
    })
    expect(() =>
      chain.start(
        'operator',
        undefined,
        ['.'],
        'operator-2',
        readback({ next_action: 'restart from HEAD' })
      )
    ).toThrow('RECOVERY_READBACK_INVALID')
    writeFileSync(chain.sdd + '.loop.json', before[0]!)
    writeFileSync(chain.sdd + '.events.jsonl', before[1]!)
    chain.start('operator', undefined, ['.'], 'operator-2', readback())
    expect(lease().started_event_id).toBeTruthy()
    expect(chain.state().operator_recovery).toBeNull()
  } finally {
    chain.restore()
    rmSync(root, { recursive: true, force: true })
  }
})
