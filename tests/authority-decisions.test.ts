import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertArtifactCustody,
  assertAuthorizationRequest,
  assertDecisionEvidenceReview
} from '../scripts/domain/policies/authority-decisions'
import { recordEvent } from '../scripts/controllers/record.controller'
import { COORDINATOR, createNativeChain } from './fixtures/native-chain'

type Item = Record<string, unknown>
const example = { language: 'ts', code: 'export const value = 1;' }
const delta = {
  must_ship_scope_change: false,
  must_ship_deferral: false,
  material_security_or_data_risk: false,
  public_api_break: true,
  major_ownership_move: false,
  behavior_deletion: false,
  irreversible_effect: false,
  external_effect: false,
  user_reserved_product_choice: false
}
const option = (id: string, recommended: boolean) => ({
  id,
  summary: `${id} route`,
  impact: 'consumers update imports',
  destructive_or_breaking_effects: 'old export removed',
  reversibility: 'revert commit',
  tradeoffs: 'simpler owner versus migration work',
  recommended,
  code_example: example
})
const request = (patch: Item = {}): Item => ({
  authorization_request: {
    authority_basis: 'PUBLIC_API_BREAK',
    question: 'May the public value export be renamed?',
    scenario: 'two owners export the same value',
    cause: 'duplicate authority',
    impact: 'one consumer import changes',
    destructive_or_breaking_effects: 'old export disappears',
    reversibility: 'revert commit',
    recommendation: 'rename',
    authorization_reason: 'public API break needs user authority',
    no_action_effect: 'duplicate owners remain',
    authority_delta: delta,
    authority_boundary_evidence: ['packages/app exports value'],
    current_code_example: example,
    options: [option('rename', true), option('keep', false)],
    ...patch
  }
})
const review = (patch: Item = {}): Item => ({
  architect_claim_ids: ['FX01'],
  claim_type: 'BEHAVIOR',
  decision_impact: 'ROUTE_CHANGING',
  method: 'TARGETED_REPRODUCTION',
  decision_flip_condition: 'value stays wrong after the proposed fix',
  result: 'CONFIRMED',
  evidence: ['reproduction output'],
  ...patch
})

test('authorization requests must cross the declared boundary with one recommendation', () => {
  expect(() => assertAuthorizationRequest(request())).not.toThrow()
  for (const [patch, code] of [
    [
      { authority_delta: { ...delta, public_api_break: false } },
      'AUTHORIZATION_USER_BOUNDARY_NOT_CROSSED'
    ],
    [{ authority_basis: 'BEHAVIOR_DELETION' }, 'AUTHORIZATION_BASIS_DELTA_MISMATCH'],
    [{ authority_delta: { public_api_break: true } }, 'AUTHORIZATION_AUTHORITY_DELTA_REQUIRED'],
    [{ options: [option('a', true), option('b', true)] }, 'AUTHORIZATION_RECOMMENDATION_INVALID'],
    [{ options: [option('a', true), option('a', false)] }, 'AUTHORIZATION_OPTION_ID_DUPLICATE'],
    [{ current_code_example: { language: 'ts' } }, 'AUTHORIZATION_CURRENT_CODE_EXAMPLE_REQUIRED']
  ] as const)
    expect(() => assertAuthorizationRequest(request(patch))).toThrow(code)
})

test('artifact custody requires executable, independently verified chains', () => {
  const item = {
    id: 'AR01',
    path: 'dist/app.sig',
    kind: 'SIGNED',
    generator_role: 'coordinator',
    signer_role: 'coordinator',
    installer_role: 'coordinator',
    verifier_role: 'architect',
    protection_policy: 'signature must match release key',
    install_mode: 'BYTE_EXACT_CUSTODY_INSTALL',
    secret_flow: 'SAME_ROLE_ONLY',
    execution_check: { outcome: 'PASS', method: 'dry-run sign', evidence: ['dry-run log'] }
  }
  const custody = (items: unknown[], extra: Item = {}) => ({
    artifact_custody: { items, ...extra }
  })
  expect(() =>
    assertArtifactCustody(custody([], { absence_evidence: ['no artifacts'] }))
  ).not.toThrow()
  expect(() => assertArtifactCustody(custody([item]))).not.toThrow()
  // Installing someone else's signature is legal only as a finished-artifact handoff.
  const handoff = { ...item, installer_role: 'operator', install_mode: 'IMPLEMENTATION_WRITE' }
  expect(() =>
    assertArtifactCustody(custody([{ ...handoff, secret_flow: 'FINAL_ARTIFACT_HANDOFF' }]))
  ).not.toThrow()
  for (const [items, code] of [
    [[], 'ARTIFACT_CUSTODY_ABSENCE_EVIDENCE_REQUIRED'],
    [[handoff], 'ARTIFACT_CUSTODY_SECRET_FLOW_INVALID'],
    [[{ ...handoff, kind: 'APPROVED_PROTECTED' }], 'ARTIFACT_CUSTODY_PROTECTED_INSTALLER_INVALID'],
    [[{ ...item, verifier_role: 'operator' }], 'ARTIFACT_CUSTODY_ITEM_INVALID'],
    [[{ ...item, install_mode: 'IMPLEMENTATION_WRITE' }], 'ARTIFACT_CUSTODY_INSTALL_MODE_INVALID'],
    [[item, { ...item, id: 'AR02' }], 'ARTIFACT_CUSTODY_DUPLICATE'],
    [
      [{ ...item, execution_check: { outcome: 'NOT_RUN' } }],
      'ARTIFACT_CUSTODY_EXECUTABILITY_REQUIRED'
    ]
  ] as const)
    expect(() => assertArtifactCustody(custody([...items]))).toThrow(code)
})

test('decision evidence uses the cheapest decisive method and never decides on material doubt', () => {
  expect(() => assertDecisionEvidenceReview(review())).not.toThrow()
  expect(() =>
    assertDecisionEvidenceReview(
      review({
        claim_type: 'ACCEPTANCE_VERDICT',
        method: 'ARTIFACT_AUDIT',
        no_rerun_reason: 'CANONICAL_ORACLE_ALREADY_INDEPENDENT'
      })
    )
  ).not.toThrow()
  for (const [patch, code] of [
    [{ claim_type: 'ROOT_CAUSE' }, 'DECISION_EVIDENCE_ROOT_CAUSE_METHOD_INVALID'],
    [
      { method: 'SOURCE_READ', claim_type: 'STATIC_FACT' },
      'DECISION_EVIDENCE_NO_RERUN_REASON_REQUIRED'
    ],
    [{ no_rerun_reason: 'HASH_OR_IDENTITY_PROOF' }, 'DECISION_EVIDENCE_NO_RERUN_REASON_FORBIDDEN'],
    [
      { decision_impact: 'TERMINAL', result: 'INCONCLUSIVE' },
      'DECISION_EVIDENCE_MATERIAL_RESULT_INCONCLUSIVE'
    ],
    [{ evidence: [] }, 'DECISION_EVIDENCE_REVIEW_INVALID']
  ] as const)
    expect(() => assertDecisionEvidenceReview(review(patch))).toThrow(code)
  expect(() =>
    assertDecisionEvidenceReview(review({ decision_impact: 'LOCAL', result: 'INCONCLUSIVE' }))
  ).not.toThrow()
})

test('user decisions wait nonterminally, are consumed only by their answer, and blockers need a real cause', () => {
  const root = mkdtempSync(join(tmpdir(), 'authority-decisions-'))
  const chain = createNativeChain(root)
  const persisted = () => [
    readFileSync(chain.sdd + '.loop.json', 'utf8'),
    readFileSync(chain.sdd + '.events.jsonl', 'utf8')
  ]
  const record = (type: string, payload: Item) =>
    recordEvent(chain.sdd, 'coordinator', chain.phase(), 'v1', type, payload, COORDINATOR)
  const rejects = (type: string, payload: Item, code: string) => {
    const before = persisted()
    expect(() => record(type, payload)).toThrow(code)
    expect(persisted()).toEqual(before)
  }
  const blocker = (patch: Item = {}) => ({
    reason: 'REQUIRED_TOOL_UNAVAILABLE',
    summary: 'the admitted signing tool is missing',
    evidence: ['which signer: not found'],
    recovery_condition: 'install the admitted signer',
    evidence_review: review({
      claim_type: 'STATIC_FACT',
      method: 'SOURCE_READ',
      no_rerun_reason: 'STATIC_FACT_DIRECTLY_READ',
      decision_impact: 'TERMINAL'
    }),
    ...patch
  })
  try {
    chain.setup()
    const decision = {
      decision: 'USER_DECISION',
      requirement_ids: ['XQ01'],
      acceptance_ids: ['YS01'],
      problem_evidence: ['duplicate value owners'],
      coordinator_runtime: chain.admission.coordinator_runtime,
      ...request()
    }
    record('contract_admission', decision)
    const pending = chain.state().pending_user_decision as Item
    expect(pending).toMatchObject({ authority_basis: 'PUBLIC_API_BREAK' })
    expect(chain.phase()).toBe('CONTRACT_DRAFT')
    rejects('contract_admission', decision, 'USER_DECISION_ALREADY_PENDING')
    // A pending authorization is never converted into a terminal blocker.
    rejects('terminal_blocker', blocker(), 'USER_DECISION_CANNOT_TRANSITION_TO_BLOCKED')
    rejects('contract_admission', chain.admission, 'ADMISSION_USER_DECISION_RESOLUTION_REQUIRED')
    rejects(
      'contract_admission',
      {
        ...chain.admission,
        user_decision_resolution: {
          request_hash: 'other',
          user_answer: 'rename',
          evidence: ['chat']
        }
      },
      'ADMISSION_USER_DECISION_RESOLUTION_REQUIRED'
    )
    chain.admit({
      ...chain.admission,
      user_decision_resolution: {
        request_hash: pending.request_hash,
        user_answer: 'rename approved',
        evidence: ['user message in current conversation']
      }
    })
    expect(chain.state().pending_user_decision).toBeNull()

    rejects('finding_decision', { action: 'attempt_completed' }, 'DEDICATED_EVENT_COMMAND_REQUIRED')
    rejects(
      'finding_decision',
      { finding_ids: ['FX01'], decision: 'IGNORE', evidence: ['x'], evidence_review: review() },
      'FINDING_DECISION_INVALID'
    )
    record('finding_decision', {
      finding_ids: ['FX01'],
      decision: 'REWRITE_ROUTE',
      evidence: ['common cause in value owner'],
      evidence_review: review()
    })

    rejects(
      'terminal_blocker',
      blocker({ reason: 'TOO_MANY_FAILURES' }),
      'TERMINAL_BLOCKER_INVALID'
    )
    rejects(
      'terminal_blocker',
      blocker({ evidence_review: review({ result: 'DISPROVED' }) }),
      'TERMINAL_BLOCKER_EVIDENCE_NOT_CONFIRMED'
    )
    record('terminal_blocker', blocker())
    chain.advance('BLOCKED')
    expect(chain.phase()).toBe('BLOCKED')
  } finally {
    chain.restore()
    rmSync(root, { recursive: true, force: true })
  }
})
