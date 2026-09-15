import { findingUpdate } from '../scripts/controllers/finding.controller'
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { signRoleEvent } from '../scripts/resource/role-signature'
import { bindEventLog, eventLogBinding } from '../scripts/resource/store/event-log-binding'
import { assertShipEvidence } from '../scripts/helpers/ship-evidence'
import { COORDINATOR, createNativeChain } from './fixtures/native-chain'

type Item = Record<string, unknown>

test('SHIP transition consumes current final evidence and rejects incomplete or stale candidates without writes', () => {
  const root = mkdtempSync(join(tmpdir(), 'ship-evidence-'))
  const chain = createNativeChain(root)
  const files = () => [chain.sdd + '.loop.json', chain.sdd + '.events.jsonl'] as const
  const read = () => files().map((path) => readFileSync(path, 'utf8')) as [string, string]
  const write = (state: string, events: string) => {
    writeFileSync(files()[0], state)
    writeFileSync(files()[1], events)
  }
  /** A rejected SHIP must leave the exact persisted state and event bytes in place. */
  const rejects = (state: string, events: string, code: string | RegExp) => {
    // Rebind altered history so each case tests the SHIP gate, not log integrity.
    const bound = bindEventLog(Buffer.from(state), eventLogBinding(Buffer.from(events))).toString()
    write(bound, events)
    expect(() => chain.advance('SHIP')).toThrow(code)
    expect(read()).toEqual([bound, events])
  }
  try {
    chain.setup()
    chain.toArchitectVerify()
    const roundVerdict = chain.verify()
    chain.advance('COORDINATOR_TRIAGE', 'FINAL_CANDIDATE', 'FINAL_VERIFY')
    const finalVerdict = chain.verify({ finding_ids: ['FX01'] })

    // A Finding closes only with a re-verification that names it.
    const [draftState] = read()
    const openFinding = { id: 'FX01', priority: 'P1', status: 'open', evidence: roundVerdict }
    writeFileSync(
      files()[0],
      JSON.stringify({ ...JSON.parse(draftState!), findings: { FX01: openFinding } })
    )
    const resolve = (evidence: string) =>
      findingUpdate(
        chain.sdd,
        'coordinator',
        'FINAL_VERIFY',
        'v1',
        'FX01',
        'P1',
        'resolved',
        evidence,
        COORDINATOR
      )
    const [withFinding, beforeResolve] = read()
    expect(() => resolve(roundVerdict)).toThrow('FINDING_REVERIFY_SCOPE_MISMATCH')
    expect(read()).toEqual([withFinding, beforeResolve])
    rejects(withFinding!, beforeResolve!, 'SHIP_FINDINGS_OPEN')
    expect(resolve(finalVerdict).status).toBe('resolved')

    // Requirement completion needs the Architect verdict, not any signed event.
    const implementationId = (
      read()[1]!
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Item)
        .findLast((event) => event.type === 'implementation') as Item
    ).event_id as string
    expect(() => chain.markVerified(implementationId)).toThrow(
      'VERIFIED_REQUIRES_ARCHITECT_VERIFICATION_EVENT'
    )
    chain.markVerified(finalVerdict)
    const [state, events] = read() as [string, string]
    const parsed = JSON.parse(state) as Item

    // Pending authority or recovery cannot be bypassed by final evidence or falsy markers.
    for (const field of [
      'pending_user_decision',
      'pending_pipeline_repair',
      'pending_execution_failure'
    ])
      for (const value of [{ id: 'pending' }, false, 0, ''])
        rejects(
          JSON.stringify({ ...parsed, [field]: value }),
          events,
          /SHIP_USER_DECISION_PENDING|SHIP_RECOVERY_PENDING|CONTRACT_ADMISSION_AUTHORITY_STALE/
        )
    // Runtime projections cannot remove or downgrade contract obligations.
    for (const altered of [
      { requirements: {}, requirement_kinds: {} },
      { requirement_kinds: { XQ01: 'should' } },
      { requirements: { XQ01: 'verified', XQ02: 'verified' } }
    ])
      rejects(
        JSON.stringify({ ...parsed, ...altered }),
        events,
        'SHIP_REQUIREMENT_PROJECTION_MISMATCH'
      )
    // A later amendment invalidates both the admission and the verdict built on it.
    rejects(
      state,
      `${events}${JSON.stringify({ event_id: 'EVT-A', type: 'contract_amendment' })}\n`,
      /SHIP_EVIDENCE_INVALIDATED|CONTRACT_ADMISSION_AUTHORITY_STALE/
    )

    // Correctly signed but altered verdicts still fail the candidate and result gates.
    const ledger = events
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Item)
    const index = ledger.findLastIndex((event) => event.type === 'verification')
    const { signature: _signature, signature_algorithm: _algorithm, ...body } = ledger[index]!
    for (const [patch, code] of [
      [{ candidate_id: 'old' }, 'SHIP_CANDIDATE_BINDING_MISMATCH'],
      [{ environment_fingerprint: 'other' }, 'SHIP_CANDIDATE_BINDING_MISMATCH'],
      [{ result: 'FAIL' }, /SHIP_FINAL_VERIFICATION_REQUIRED|VERIFICATION_EVIDENCE_SUPERSEDED/],
      [{ acceptance_ids: [] }, 'VERIFICATION_ACCEPTANCE_IDS_REQUIRED']
    ] as const) {
      // Re-sign with the real minted Architect credential so only the altered content differs.
      const signer = chain.token(String((body.actor as Item).lease_id))!
      const forged = signRoleEvent(
        { ...body, payload: { ...(body.payload as Item), ...patch } },
        signer
      )
      const altered = [...ledger.slice(0, index), forged, ...ledger.slice(index + 1)]
      expect(() => assertShipEvidence(parsed, altered, COORDINATOR, chain.sdd)).toThrow(code)
    }
    expect(() =>
      assertShipEvidence(parsed, ledger.slice(0, index), COORDINATOR, chain.sdd)
    ).toThrow()

    // Product bytes changed after verification invalidate the candidate until restored.
    writeFileSync(join(chain.workspace, chain.productFile), 'export const value = 3;')
    rejects(state, events, 'CANDIDATE_WORKTREE_CHANGED')
    writeFileSync(join(chain.workspace, chain.productFile), 'export const value = 2;')
    write(state, events)
    chain.advance('SHIP')
    expect(chain.phase()).toBe('SHIP')
  } finally {
    chain.restore()
    rmSync(root, { recursive: true, force: true })
  }
})
