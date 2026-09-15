import { writeFileSync } from 'node:fs'
import { coordinatorBrief } from '../scripts/services/coordinator-brief'
import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { failure } from '../scripts/controllers/failure.controller'
import { createNativeChain } from './fixtures/native-chain'

/** Persisted bytes that a rejected mutation must leave untouched. */
const snapshot = (sdd: string) => [
  readFileSync(sdd + '.loop.json', 'utf8'),
  readFileSync(sdd + '.events.jsonl', 'utf8')
]

for (const multiPacket of [false, true])
  test(`native ${multiPacket ? 'dependent packets' : 'single packet'} handoff and final verdict reach SHIP`, () => {
    const root = mkdtempSync(join(tmpdir(), 'native-handoff-'))
    const chain = createNativeChain(root, { packetIds: multiPacket ? ['PC01', 'PC02'] : ['PC01'] })
    const check = () => expect(chain.check()).toBe(0)
    try {
      chain.setup()
      chain.admit()
      // A product execution failure invalidates admission until a reviewed route is readmitted.
      let leaseId = chain.readback(multiPacket ? 'PC01' : undefined)
      failure(
        'execution',
        chain.sdd,
        'coordinator',
        chain.phase(),
        'v1',
        'operator',
        'fixture route needs repair',
        'fixture-route',
        'coordinator'
      )
      expect(chain.state().pending_execution_failure).not.toBeNull()
      expect(chain.state().active_lease).toBeNull()
      chain.admit({
        ...chain.admission,
        execution_failure_review: {
          root_cause_key: 'fixture-route',
          cause_evidence: ['fixture failure'],
          execution_topology_findings: ['update producer before checking consumer'],
          revised_execution_packet_ids: multiPacket ? ['PC01', 'PC02'] : ['PC01'],
          route_change: 'correct the fixture producer',
          falsifier: 'wrong value still observed'
        }
      })
      expect(chain.state().pending_execution_failure).toBeNull()
      expect(chain.state().total_execution_failures).toBe(1)
      leaseId = chain.readback(multiPacket ? 'PC01' : undefined)
      chain.advance('READBACK_APPROVED', 'IMPLEMENTING')

      // Every missing or blank candidate binding is rejected before any persistence.
      const rejected = snapshot(chain.sdd)
      for (const invalid of [undefined, null, [], {}]) {
        expect(() =>
          chain.record(
            'operator',
            leaseId,
            'implementation',
            invalid === undefined
              ? { execution_packet_ids: ['PC01'], changed_packages: ['.'], test_changes: [] }
              : {
                  candidate: invalid,
                  execution_packet_ids: ['PC01'],
                  changed_packages: ['.'],
                  test_changes: []
                }
          )
        ).toThrow('CANDIDATE_')
        expect(snapshot(chain.sdd)).toEqual(rejected)
      }

      chain.implement(leaseId, 'export const value = 2;', multiPacket ? 'PC01' : undefined)
      if (multiPacket) {
        // Implementation of a non-final packet releases its lease; the successor packet
        // cannot start from drifted bytes and must bind its own real delta.
        expect(chain.state().active_lease).toBeNull()
        leaseId = chain.start('operator', 'PC02')
        chain.implement(leaseId, 'export const value = 1 + 1;', 'PC02', 'candidate-2')
        expect(chain.state().active_lease).toBeNull()
      }
      chain.advance('OPERATOR_SELF_CHECK')
      if (multiPacket) leaseId = chain.start('operator')
      check()
      // Self-checks cite controller-measured runs on the current candidate.
      chain.runTests(leaseId)
      // A failed self-check keeps the lease and counters; it cannot hand off.
      const beforeFailure = chain.state()
      chain.record('operator', leaseId, 'self_check', chain.selfCheckPayload('FAIL'))
      expect(chain.state().active_lease).toEqual(beforeFailure.active_lease)
      expect(chain.state().completed_attempts).toBe(beforeFailure.completed_attempts)
      const failedCheck = snapshot(chain.sdd)
      expect(() => chain.advance('ARCHITECT_VERIFY')).toThrow()
      expect(snapshot(chain.sdd)).toEqual(failedCheck)
      const stale = { ...chain.selfCheckPayload(), candidate_id: 'stale' }
      expect(() => chain.record('operator', leaseId, 'self_check', stale)).toThrow(
        'CANDIDATE_RESULT_BINDING_MISMATCH'
      )
      expect(snapshot(chain.sdd)).toEqual(failedCheck)
      chain.record('operator', leaseId, 'self_check', chain.selfCheckPayload())
      expect(chain.state().active_lease).toBeNull()

      chain.advance('ARCHITECT_VERIFY')
      check()
      chain.verify()
      chain.advance('COORDINATOR_TRIAGE', 'FINAL_CANDIDATE', 'FINAL_VERIFY')
      // SHIP needs the current FINAL_VERIFY verdict, not the round verification.
      const beforeFinal = snapshot(chain.sdd)
      expect(() => chain.advance('SHIP')).toThrow()
      expect(snapshot(chain.sdd)).toEqual(beforeFinal)
      check()
      const verdict = chain.verify()
      expect(chain.state().active_lease).toBeNull()
      // The brief follows the SHIP gate: a passing verdict first needs its requirement status.
      expect(coordinatorBrief(chain.sdd).obligations).toContain(
        'RECORD_REQUIREMENT_STATUS_THEN_SHIP'
      )
      chain.markVerified(verdict)
      expect(coordinatorBrief(chain.sdd).obligations).toContain('TRANSITION_SHIP')
      // Any other SHIP rejection is reported with the gate's own code, never as a status to record.
      const statePath = chain.sdd + '.loop.json'
      const shippable = readFileSync(statePath, 'utf8')
      const withOpenFinding = JSON.parse(shippable)
      withOpenFinding.findings = { FX99: { id: 'FX99', status: 'open', priority: 'P1' } }
      writeFileSync(statePath, JSON.stringify(withOpenFinding))
      const blocked = coordinatorBrief(chain.sdd)
      expect(blocked.obligations).toContain('RESOLVE_SHIP_GATE:SHIP_FINDINGS_OPEN')
      expect(blocked.ship_gate).toMatchObject({ ready: false, code: 'SHIP_FINDINGS_OPEN' })
      writeFileSync(statePath, shippable)
      chain.advance('SHIP')
      expect(chain.phase()).toBe('SHIP')
    } finally {
      chain.restore()
      rmSync(root, { recursive: true, force: true })
    }
  })
