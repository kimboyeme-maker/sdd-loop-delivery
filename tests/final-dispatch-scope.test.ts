import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { admissionFixture } from './fixtures/admission'
import { createNativeChain } from './fixtures/native-chain'
import { dispatch } from '../scripts/controllers/dispatch.controller'
import { finalVerificationScope } from '../scripts/helpers/admission-authority'

test('final Architect scope includes earlier Must-Ship work outside the last admission', () => {
  const root = mkdtempSync(join(tmpdir(), 'final-dispatch-'))
  const first = admissionFixture('packages/earlier')
  const second: ReturnType<typeof admissionFixture> = JSON.parse(
    JSON.stringify(admissionFixture('packages/current'))
      .replaceAll('XQ01', 'XQ02')
      .replaceAll('YS01', 'YS02')
      .replaceAll('CL01', 'CL02')
      .replaceAll('fixture-check', 'fixture-check-current')
      .replaceAll('fixture-result', 'fixture-result-current')
  )
  const contract = {
    ...first.contract,
    ownership: { ...first.contract.ownership, packages: ['packages/earlier', 'packages/current'] },
    requirements: [...first.contract.requirements, ...second.contract.requirements],
    acceptance: [...first.contract.acceptance, ...second.contract.acceptance]
  }
  const admission = {
    ...second.payload,
    must_ship_decision_closure: {
      ...second.payload.must_ship_decision_closure,
      requirement_ids: ['XQ01', 'XQ02']
    },
    sdd_convergence_review: {
      ...second.payload.sdd_convergence_review,
      reviewed_acceptance_ids: ['YS01', 'YS02']
    }
  }
  const chain = createNativeChain(root, { contract, admission })
  const issue = (scope: string[], packet?: string) =>
    dispatch(
      chain.sdd,
      'coordinator',
      chain.phase(),
      'v1',
      'architect',
      'architect',
      1,
      5,
      scope,
      'verify current candidate',
      'coordinator',
      packet === undefined ? {} : { packet }
    )
  try {
    chain.setup()
    chain.toArchitectVerify()
    // Round verification stays inside the latest admission's observation surfaces.
    expect(() => issue(['packages/earlier', 'packages/current'])).toThrow(
      'ADMISSION_DISPATCH_SCOPE_INVALID'
    )
    expect(chain.check()).toBe(0)
    chain.verify()
    chain.advance('COORDINATOR_TRIAGE', 'FINAL_CANDIDATE', 'FINAL_VERIFY')
    const before = readFileSync(chain.sdd + '.loop.json', 'utf8'),
      events = readFileSync(chain.sdd + '.events.jsonl', 'utf8')
    for (const [scope, packet, code] of [
      [['packages/earlier', 'packages/current'], 'PC01', 'FINAL_VERIFICATION_PACKET_FORBIDDEN'],
      [['packages/unrelated'], undefined, 'FINAL_VERIFICATION_SCOPE_INVALID']
    ] as const) {
      expect(() => issue([...scope], packet)).toThrow(code)
      expect(readFileSync(chain.sdd + '.loop.json', 'utf8')).toBe(before)
      expect(readFileSync(chain.sdd + '.events.jsonl', 'utf8')).toBe(events)
    }
    issue(['packages/earlier', 'packages/current'])
    const lease = chain.state().active_lease as Record<string, unknown>
    expect(lease.requirement_ids).toEqual(['XQ01', 'XQ02'])
    expect(lease.acceptance_ids).toEqual(['YS01', 'YS02'])
  } finally {
    chain.restore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('final scope rejects missing normative links rather than guessing from the last packet', () => {
  const fixture = admissionFixture('src')
  expect(finalVerificationScope(fixture.contract, ['src/file.ts'])).toEqual({
    requirement_ids: ['XQ01'],
    acceptance_ids: ['YS01']
  })
  fixture.contract.acceptance[0]!.requirement_ids = []
  expect(() => finalVerificationScope(fixture.contract, ['src'])).toThrow(
    'FINAL_VERIFICATION_CONTRACT_INVALID'
  )
})
