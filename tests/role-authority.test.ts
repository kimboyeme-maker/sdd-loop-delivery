import { rolePublicKey, verifyRoleEvent } from '../scripts/resource/role-signature'
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { agentRecord } from '../scripts/controllers/agent-record.controller'

for (const role of ['operator', 'architect'] as const) {
  test(
    role + ' cannot submit the other role evidence and may sign its own recovery checkpoint',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'role-authority-'))
      const sdd = join(root, 'task.md')
      const hash = (s: string) => createHash('sha256').update(s).digest('hex')
      const phase = role === 'operator' ? 'IMPLEMENTING' : 'ARCHITECT_VERIFY'
      const checkpoint = {
        status: 'SAFE_TO_RESUME',
        completed_actions: [],
        remaining_actions: ['resume fixture task'],
        active_commands: [],
        repository_state: {
          head: 'fixture-head',
          worktree_fingerprint: 'sha256:' + '0'.repeat(64),
          changed_paths: [],
          untracked_paths: []
        },
        last_check: {
          method: 'fixture check',
          outcome: 'PASS',
          evidence: 'synthetic authentication fixture'
        },
        resume: {
          next_action: 'inspect task',
          preconditions: ['lease remains valid'],
          stop_conditions: ['source changes']
        }
      }
      try {
        writeFileSync(sdd, '# isolated fixture')
        writeFileSync(
          sdd + '.loop.json',
          JSON.stringify({
            protocol: 'control-plane/state-v2',
            sdd_fingerprint: hash('# isolated fixture'),
            phase: phase,
            revision: 1,
            contract_revision: 'v1',
            coordinator_token_hash: hash('coordinator'),
            authority_epoch: 1,
            active_lease: {
              role,
              authority_epoch: 1,
              issued_at: new Date().toISOString(),
              hard_deadline_minutes: 5,
              agent_id: 'actor',
              lease_id: 'lease',
              dispatch_event_id: 'fixture-dispatch',
              agent_token_hash: hash('agent'),
              event_public_key: rolePublicKey('agent'),
              contract_revision: 'v1'
            }
          })
        )
        writeFileSync(sdd + '.events.jsonl', '')
        const before = readFileSync(sdd + '.loop.json')
        let reads = 0
        const accessor = Object.defineProperty({}, 'candidate', {
          enumerable: true,
          get() {
            reads++
            return {}
          }
        })
        for (const payload of [accessor, { value: Infinity }, { value: undefined }]) {
          expect(() =>
            agentRecord(
              sdd,
              role,
              'actor',
              'lease',
              phase,
              'v1',
              'checkpoint',
              payload,
              'agent',
              'coordinator'
            )
          ).toThrow('CANONICAL_')
          expect(readFileSync(sdd + '.loop.json')).toEqual(before)
          expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe('')
        }
        expect(reads).toBe(0)
        const forbidden =
          role === 'operator' ? ['verification', 'finding'] : ['implementation', 'self_check']
        for (const type of forbidden) {
          expect(() =>
            agentRecord(
              sdd,
              role,
              'actor',
              'lease',
              phase,
              'v1',
              type,
              { result: 'PASS' },
              'agent',
              'coordinator'
            )
          ).toThrow('AGENT_EVENT_ROLE_FORBIDDEN')
          expect(readFileSync(sdd + '.loop.json')).toEqual(before)
          expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe('')
        }
        // Checkpoints can preserve recovery information before startup; they do not claim product PASS.
        const allowed = 'checkpoint'
        for (const [patch, error] of [
          [{ event_public_key: undefined }, 'AGENT_EVENT_KEY_REQUIRED'],
          [{ event_public_key: null }, 'AGENT_EVENT_KEY_REQUIRED'],
          [{ event_public_key: '' }, 'AGENT_EVENT_KEY_REQUIRED'],
          [{ event_public_key: rolePublicKey('other') }, 'AGENT_EVENT_KEY_MISMATCH'],
          [{ authority_epoch: 0 }, 'AGENT_LEASE_EPOCH_MISMATCH'],
          [{ issued_at: '2000-01-01T00:00:00.000Z' }, 'AGENT_LEASE_EXPIRED'],
          [{ hard_deadline_minutes: null }, 'AGENT_LEASE_DEADLINE_UNVERIFIABLE'],
          [{ issued_at: 'invalid' }, 'AGENT_LEASE_DEADLINE_UNVERIFIABLE']
        ] as const) {
          const invalid = JSON.parse(before.toString())
          Object.assign(invalid.active_lease, patch)
          const bytes = JSON.stringify(invalid)
          writeFileSync(sdd + '.loop.json', bytes)
          expect(() =>
            agentRecord(
              sdd,
              role,
              'actor',
              'lease',
              phase,
              'v1',
              allowed,
              checkpoint,
              'agent',
              'coordinator'
            )
          ).toThrow(error)
          expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(bytes)
          expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe('')
        }
        for (const revision of [undefined, null, '1', -1, 1.5, Number.MAX_SAFE_INTEGER]) {
          const invalid = { ...JSON.parse(before.toString()), revision }
          const bytes = JSON.stringify(invalid)
          writeFileSync(sdd + '.loop.json', bytes)
          expect(() =>
            agentRecord(
              sdd,
              role,
              'actor',
              'lease',
              phase,
              'v1',
              allowed,
              checkpoint,
              'agent',
              'coordinator'
            )
          ).toThrow('CONTROL_REVISION_INVALID')
          expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(bytes)
          expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe('')
        }
        writeFileSync(sdd + '.loop.json', before)
        expect(
          agentRecord(
            sdd,
            role,
            'actor',
            'lease',
            phase,
            'v1',
            allowed,
            checkpoint,
            'agent',
            'coordinator'
          ).protocol
        ).toBe('agent-record/v1')
        const event = JSON.parse(readFileSync(sdd + '.events.jsonl', 'utf8'))
        expect(JSON.parse(readFileSync(sdd + '.loop.json', 'utf8')).revision).toBe(2)
        expect(event.signature_algorithm).toBe('ed25519-role-v1')
        expect(verifyRoleEvent(event, rolePublicKey('agent'))).toBe(true)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
}
