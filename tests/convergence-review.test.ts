import { roleRuntime } from '../scripts/config/host'
import { rolePublicKey } from '../scripts/resource/role-signature'
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordEvent } from '../scripts/controllers/record.controller'
import { assertConvergenceReview } from '../scripts/helpers/convergence-review'
import type { Contract } from '../scripts/domain/contract'

test('independent logic review covers every authored step once with actual trace fields', () => {
  const contract: Contract = {
    revision: 'v1',
    requirements: [
      {
        id: 'XQ01',
        kind: 'must-ship',
        title: 'cancel',
        acceptance: ['YS01']
      } as Contract['requirements'][number]
    ],
    implementation_logic: {
      paths: [
        { id: 'PC01', steps: [{ id: 'ST01' }, { id: 'ST02' }] },
        { id: 'PC02', steps: [{ id: 'ST03' }] }
      ]
    }
  }
  const trace = {
    path_id: 'PC01',
    step_ids: ['ST01', 'ST02'],
    result: 'PASS',
    counterexample: 'cancel before callback',
    method: 'trace state and cleanup',
    observed_result: 'cleanup precedes terminal callback',
    evidence: ['trace.log']
  }
  const other = { ...trace, path_id: 'PC02', step_ids: ['ST03'] }
  const review = {
    sdd_revision: 'v1',
    independent_result: 'PASS',
    reviewed_acceptance_ids: ['YS01'],
    evidence: ['review.log'],
    unresolved_information_questions: [],
    pending_authority_confirmations: [],
    route_critical_unknowns: [],
    blocking_findings: [],
    material_findings: [],
    acceptance_topology: {
      method: 'run cancellation',
      failure_condition: 'double callback',
      observed_result: 'one callback',
      evidence: ['run.log']
    }
  }
  const check = (traces: unknown) =>
    assertConvergenceReview(
      contract,
      {
        sdd_convergence_review: {
          ...review,
          logic_review: { traces, design_fingerprint: 'bound' }
        }
      },
      'bound'
    )
  expect(() => check([other, trace])).not.toThrow()
  expect(() =>
    assertConvergenceReview(
      contract,
      {
        sdd_convergence_review: {
          ...review,
          logic_review: { traces: [trace, other], design_fingerprint: 'stale' }
        }
      },
      'bound'
    )
  ).toThrow('INDEPENDENT_LOGIC_REVIEW_BINDING_REQUIRED')
  for (const traces of [
    [],
    [trace],
    [trace, trace],
    [trace, other, other],
    [{ ...trace, step_ids: ['ST01'] }, other],
    [{ ...trace, step_ids: ['ST01', 'ST01'] }, other],
    [{ ...trace, step_ids: ['ST01', 'ST99'] }, other],
    [{ ...trace, observed_result: '' }, other],
    [{ ...trace, evidence: [] }, other],
    [{ ...trace, result: 'FAIL' }, other]
  ])
    expect(() => check(traces)).toThrow()
  for (const logic of [
    null,
    {},
    { paths: [] },
    { paths: [{ id: 'PC01', steps: [] }] },
    { paths: [{ id: 'PC01', steps: [{ id: 'ST01' }, { id: 'ST01' }] }] }
  ]) {
    expect(() =>
      assertConvergenceReview(
        { ...contract, implementation_logic: logic },
        { sdd_convergence_review: { ...review, logic_review: { traces: [trace, other] } } }
      )
    ).toThrow('IMPLEMENTATION_LOGIC_INVALID')
  }
})

test('admission attestation requires current, clean and exact acceptance observations with zero-write rejection', () => {
  const root = mkdtempSync(join(tmpdir(), 'convergence-review-'))
  const sdd = join(root, 'sdd.md')
  const contract = {
    protocol: 'sdd-loop-delivery/v1',
    revision: 'v1',
    lineage: { mode: 'fresh' },
    ownership: { approval_authority: 'existing user scope', packages: ['src'] },
    acceptance: [
      {
        id: 'YS01',
        execution: {
          isolation: 'SHARED_SAFE',
          timeout_seconds: 30,
          readiness_oracle: 'callback queue empty before check',
          state_boundary: 'fresh handler instance',
          evidence_boundary: 'cancel-result',
          blocking_acceptance_ids: [],
          failure_containment: 'dispose handler and drain callbacks after each check'
        },
        oracle: 'completion observes the specified terminal state',
        environment: 'isolated local fixture with deterministic callback scheduling',
        claim: {
          id: 'CL01',
          statement: 'the specified behavior holds',
          dimension: 'BEHAVIOR',
          quantifier: 'SINGLE'
        },
        requirement_ids: ['XQ01'],
        packages: ['src'],
        method: 'cancel-probe'
      },
      {
        id: 'YS02',
        execution: {
          isolation: 'SHARED_SAFE',
          timeout_seconds: 30,
          readiness_oracle: 'callback queue empty before check',
          state_boundary: 'fresh handler instance',
          evidence_boundary: 'completion-result',
          blocking_acceptance_ids: [],
          failure_containment: 'dispose handler and drain callbacks after each check'
        },
        oracle: 'completion observes the specified terminal state',
        environment: 'isolated local fixture with deterministic callback scheduling',
        claim: {
          id: 'CL02',
          statement: 'the specified behavior holds',
          dimension: 'BEHAVIOR',
          quantifier: 'SINGLE'
        },
        requirement_ids: ['XQ01'],
        packages: ['src'],
        method: 'cancel-probe'
      }
    ],
    requirements: [
      {
        id: 'XQ01',
        kind: 'must-ship',
        title: 'deliver cancellation',
        acceptance: ['YS01', 'YS02']
      }
    ]
  }
  const source = `<!-- sdd-contract:start -->\n\`\`\`json\n${JSON.stringify(contract)}\n\`\`\`\n<!-- sdd-contract:end -->`
  const initial = {
    protocol: 'control-plane/state-v2',
    phase: 'CONTRACT_DRAFT',
    revision: 1,
    authority_epoch: 1,
    coordinator_event_keys: { '1': rolePublicKey('token') },
    contract_revision: 'v1',
    sdd_fingerprint: createHash('sha256').update(source).digest('hex'),
    coordinator_token_hash: createHash('sha256').update('token').digest('hex'),
    pending_execution_failure: { root_cause_key: 'cancel-race' },
    total_execution_failures: 2
  }
  const review = {
    sdd_revision: 'v1',
    independent_result: 'PASS',
    reviewed_acceptance_ids: ['YS01', 'YS02'],
    evidence: ['observed cancellation and completion order'],
    unresolved_information_questions: [],
    pending_authority_confirmations: [],
    route_critical_unknowns: [],
    blocking_findings: [],
    material_findings: [],
    acceptance_topology: {
      method: 'trace cancellation before completion',
      failure_condition: 'completion after cancellation',
      observed_result: 'cancellation closes the terminal state',
      evidence: ['trace output']
    }
  }
  const packet = {
    id: 'PC01',
    outcome: 'close cancellation race',
    requirement_ids: ['XQ01'],
    acceptance_ids: ['YS01', 'YS02'],
    preconditions: ['owner exists'],
    causal_scope: ['terminal callback'],
    stop_or_escalate: ['owner differs from design'],
    test_budget: { minutes: 5, max_new_test_files: 0 }
  }
  let submitted: Record<string, unknown> = {}
  const record = (payload: Record<string, unknown>) =>
    recordEvent(
      sdd,
      'coordinator',
      'CONTRACT_DRAFT',
      'v1',
      'contract_admission',
      (submitted = {
        requirement_ids: ['XQ01'],
        acceptance_ids: ['YS01', 'YS02'],
        fact_closure: {
          lineage_mode: 'fresh',
          unresolved_fact_ids: [],
          inherited_obligations: [],
          facts: [
            {
              id: 'FT01',
              evidence_kind: 'TEST_RESULT',
              claim_ids: ['CL01'],
              packages: ['src'],
              requirement_ids: ['XQ01'],
              acceptance_ids: ['YS01'],
              claim: 'cancellation closes before callback',
              status: 'CONFIRMED_PASS',
              source: {
                kind: 'COMMAND',
                reference: 'cancel-probe',
                observed: 'closed before callback'
              }
            }
          ]
        },
        unknowns: [],
        semantic_ownership: {
          cross_clause_evidence: ['state and callback agree on owner'],
          items: [
            {
              id: 'SO01',
              subject: 'terminal state',
              authoritative_owner: 'handler',
              requirement_ids: ['XQ01'],
              evidence: ['owner source inspection'],
              participants: []
            }
          ],
          primitive_search_evidence: ['existing handler owns terminal state'],
          primitive_decisions: [],
          unresolved_conflicts: []
        },
        responsibility: {
          decision_owner: 'coordinator',
          implementation_owner: 'operator',
          verification_owner: 'architect',
          approval_authority: 'existing user scope'
        },
        modification_packages: ['src'],
        claim_dispositions: [
          {
            claim_id: 'CL01',
            disposition: 'IMPLEMENTATION_REQUIRED',
            fact_ids: [],
            packet_ids: ['PC01'],
            evidence: ['implement the cancellation contract']
          },
          {
            claim_id: 'CL02',
            disposition: 'IMPLEMENTATION_REQUIRED',
            fact_ids: [],
            packet_ids: ['PC01'],
            evidence: ['implement terminal completion ordering']
          }
        ],
        verification_scope: {
          mode: 'CAUSAL_CLOSURE',
          external_failure_policy: 'NON_BLOCKING_UNLESS_CAUSAL_OR_ORACLE_MASKING',
          surfaces: [
            {
              id: 'VS01',
              target: 'cancellation',
              causal_basis: 'terminal state',
              method: 'cancel-probe',
              requirement_ids: ['XQ01'],
              acceptance_ids: ['YS01', 'YS02'],
              packages: ['src']
            }
          ],
          workspace_wide_gate: { disposition: 'NOT_APPLICABLE', evidence: [] }
        },
        workload: {
          affected_packages: ['src'],
          verification_surfaces: ['cancellation callback'],
          confidence: 'HIGH'
        },
        difficulty: { level: 'ROUTINE', drivers: ['local terminal ordering'] },
        round_outcome: 'close cancellation race',
        rollback_or_containment: 'preserve completed cleanup',
        top_failure_mode: 'callback observes open state',
        early_falsifier: 'cancel before callback',
        problem_evidence: ['race trace'],
        downstream_impacts: ['callback consumers see closed state'],
        conventional_route: {
          summary: 'close before notifying',
          applicability: 'FIT',
          evidence: 'owner state trace'
        },
        selected_route_id: 'RT01',
        route_options: [{ id: 'RT01', disposition: 'SELECTED', evidence: 'owner state trace' }],
        assumptions_checked: [
          {
            id: 'AS01',
            claim: 'cancellation route is executable',
            evidence: 'probe completed',
            category: 'ROUTE_FEASIBILITY',
            status: 'PROVEN',
            evidence_fact_ids: ['FT01']
          }
        ],
        early_falsifier_result: {
          outcome: 'SURVIVED',
          method: 'cancel-probe',
          failure_condition: 'callback sees open state',
          observed_result: 'callback sees closed state',
          target_assumption_ids: ['AS01'],
          requirement_ids: ['XQ01'],
          acceptance_ids: ['YS01'],
          evidence_fact_ids: ['FT01'],
          evidence: ['cancel-probe output']
        },
        must_ship_decision_closure: {
          requirement_ids: ['XQ01'],
          decision_requirement_ids: [],
          unresolved_decisions: [],
          dimensions: [
            'SEMANTIC_OWNER',
            'DEPENDENCY_DIRECTION',
            'PUBLIC_CONTRACT',
            'DIRECT_CONSUMERS',
            'USER_AUTHORITY'
          ].map((dimension) => ({
            dimension,
            disposition: dimension === 'USER_AUTHORITY' ? 'NOT_REQUIRED' : 'CLOSED',
            evidence: ['reviewed current cancellation contract']
          }))
        },
        artifact_custody: { items: [], absence_evidence: ['no protected artifact in scope'] },
        coordinator_runtime: {
          model: roleRuntime('coordinator').spawn_model,
          reasoning_effort: roleRuntime('coordinator').reasoning_effort,
          evidence: 'host spawn receipt'
        },
        ...payload
      }),
      'token'
    )
  try {
    writeFileSync(sdd, source)
    writeFileSync(sdd + '.loop.json', JSON.stringify(initial))
    writeFileSync(sdd + '.events.jsonl', '')
    for (const phase of [
      'IMPLEMENT',
      'VERIFY',
      'FINAL_VERIFY',
      'SHIP',
      'CANCELLED',
      'PAUSED',
      'BLOCKED',
      'DISCOVER'
    ]) {
      const bytes = JSON.stringify({ ...initial, phase })
      writeFileSync(sdd + '.loop.json', bytes)
      expect(() =>
        recordEvent(
          sdd,
          'coordinator',
          phase,
          'v1',
          'contract_admission',
          { decision: 'ADMIT' },
          'token'
        )
      ).toThrow(/CONTRACT_ADMISSION_STATE_INVALID|TERMINAL_STATE_IMMUTABLE|LOOP_PAUSED/)
      expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(bytes)
      expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe('')
    }
    writeFileSync(sdd + '.loop.json', JSON.stringify(initial))
    for (const invalid of [
      undefined,
      {},
      { ...review, sdd_revision: 'v0' },
      { ...review, reviewed_acceptance_ids: ['YS01'] },
      { ...review, reviewed_acceptance_ids: ['YS01', 'YS01'] },
      { ...review, reviewed_acceptance_ids: ['YS01', 'YS03'] },
      { ...review, route_critical_unknowns: ['unknown owner'] },
      { ...review, blocking_findings: undefined },
      { ...review, acceptance_topology: { ...review.acceptance_topology, observed_result: '' } }
    ]) {
      expect(() => record({ decision: 'ADMIT', sdd_convergence_review: invalid })).toThrow()
      expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(JSON.stringify(initial))
      expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe('')
    }
    const repair = {
      root_cause_key: 'cancel-race',
      cause_evidence: ['callback trace'],
      execution_topology_findings: ['cleanup must precede callback'],
      revised_execution_packet_ids: ['PC01'],
      route_change: 'close state before notifying',
      falsifier: 'callback observes open state'
    }
    for (const executionFailure of [
      undefined,
      { ...repair, root_cause_key: 'other' },
      { ...repair, revised_execution_packet_ids: ['PC99'] },
      { ...repair, falsifier: '' },
      { ...repair, route_change_kind: 'DESIGN_REPAIR' }
    ]) {
      expect(() =>
        record({
          decision: 'ADMIT',
          sdd_convergence_review: review,
          execution_packets: [packet],
          execution_failure_review: executionFailure
        })
      ).toThrow()
      expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(JSON.stringify(initial))
      expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe('')
    }
    const factsBeforeAdmission = submitted.fact_closure as Record<string, unknown>
    const existingFacts = factsBeforeAdmission.facts as Record<string, unknown>[]
    for (const invalidFacts of [
      { ...factsBeforeAdmission, unresolved_fact_ids: ['FT01'] },
      {
        ...factsBeforeAdmission,
        facts: [...existingFacts, { ...existingFacts[0], id: 'FT02', requirement_ids: ['XQ99'] }]
      }
    ]) {
      expect(() =>
        record({
          decision: 'ADMIT',
          sdd_convergence_review: review,
          execution_packets: [packet],
          execution_failure_review: repair,
          fact_closure: invalidFacts
        })
      ).toThrow()
      expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(JSON.stringify(initial))
      expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe('')
    }
    record({
      decision: 'ADMIT',
      sdd_convergence_review: review,
      execution_packets: [packet],
      execution_failure_review: repair
    })
    const state = JSON.parse(readFileSync(sdd + '.loop.json', 'utf8'))
    // All admission checks succeeded; clearing the pending marker preserves history/counts.
    expect(state.pending_execution_failure).toBeNull()
    expect(state.phase).toBe('CONTRACT_DRAFT')
    expect(state.total_execution_failures).toBe(2)
    expect(state.revision).toBe(2)

    // Exercise the public CLI with a fully bound migration, then mutate only
    // its cutover claim. A signed generic event must not bypass this policy.
    const migrated = {
      ...contract,
      migration_applicability: 'REQUIRED',
      acceptance: [
        contract.acceptance[0]!,
        {
          ...contract.acceptance[1]!,
          claim: {
            ...contract.acceptance[1]!.claim,
            quantifier: 'UNIVERSAL',
            universe: ['callback', 'consumer']
          },
          oracle_sensitivity: {
            applicability: 'REQUIRED',
            fault_model: 'old callback remains executable',
            perturbation_method: 'enable old callback in isolated fixture',
            restoration_method: 'restore new callback routing and dispose fixture',
            expected_flip: 'PASS_TO_FAIL_TO_PASS',
            implementation_timing: 'IMPLEMENTATION_REQUIRED'
          }
        }
      ],
      migration: {
        inventory_roots: ['src'],
        inventory_method: 'scan callback and consumer',
        inventory_evidence: ['source inventory'],
        unknown_readers: [],
        legacy_surfaces: [
          {
            id: 'LS01',
            owner: 'old-handler',
            symbols: ['oldNotify'],
            final_disposition: 'REMOVE',
            requirement_ids: ['XQ01'],
            acceptance_ids: ['YS02'],
            zero_reader_acceptance_ids: ['YS02']
          }
        ],
        readers: [
          {
            id: 'RD01',
            module: 'consumer',
            edge: 'consumer calls oldNotify',
            target_owner: 'new-handler',
            owning_test: 'consumer.test.ts',
            disposition: 'MIGRATE',
            legacy_surface_ids: ['LS01'],
            requirement_ids: ['XQ01'],
            acceptance_ids: ['YS01'],
            evidence: ['consumer source']
          }
        ]
      }
    }
    const migratedSource = `<!-- sdd-contract:start -->\n\`\`\`json\n${JSON.stringify(migrated)}\n\`\`\`\n<!-- sdd-contract:end -->`
    const migratedInitial = {
      ...initial,
      sdd_fingerprint: createHash('sha256').update(migratedSource).digest('hex')
    }
    const admission = {
      ...submitted,
      fact_closure: {
        lineage_mode: 'fresh',
        unresolved_fact_ids: [],
        inherited_obligations: [],
        facts: [
          {
            id: 'FT01',
            evidence_kind: 'SOURCE_INSPECTION',
            claim_ids: ['CL02'],
            packages: ['src'],
            requirement_ids: ['XQ01'],
            acceptance_ids: ['YS02'],
            claim: 'closed reader inventory',
            status: 'CONFIRMED_PASS',
            covered_universe: ['callback', 'consumer'],
            source: {
              kind: 'SOURCE_INSPECTION',
              reference: 'consumer source',
              observed: 'callback and consumer located'
            }
          }
        ]
      },
      assumptions_checked: [
        {
          id: 'AS01',
          claim: 'all readers located',
          evidence: 'inventory output',
          category: 'MIGRATION_READER_CLOSURE',
          status: 'PROVEN',
          evidence_fact_ids: ['FT01']
        }
      ],
      early_falsifier_result: {
        outcome: 'SURVIVED',
        probe_kind: 'MIGRATION_READER_INVENTORY',
        method: migrated.migration.inventory_method,
        failure_condition: 'unknown reader',
        observed_result: 'all readers located',
        target_assumption_ids: ['AS01'],
        requirement_ids: ['XQ01'],
        acceptance_ids: ['YS02'],
        evidence_fact_ids: ['FT01'],
        evidence: ['inventory output']
      },
      migration_closure: {
        applicability: 'REQUIRED',
        unresolved_reader_ids: [],
        cutover_mode: 'COORDINATED_ATOMIC',
        inventory_fact_ids: ['FT01'],
        atomicity_evidence: ['consumer and old callback removed in one local candidate'],
        legacy_runtime_authority: [
          {
            legacy_surface_id: 'LS01',
            applicability: 'REQUIRED',
            evidence: ['retained entry probe'],
            acceptance_ids: ['YS02'],
            forbidden_behavior: 'old callback executable',
            probe_method: 'invoke retained entry',
            observed_result: 'old callback not invoked',
            oracle_independence: 'INDEPENDENT_FIXTURE'
          }
        ],
        reader_packet_bindings: [{ reader_id: 'RD01', packet_id: 'PC01' }],
        removal_packet_bindings: [{ legacy_surface_id: 'LS01', packet_id: 'PC01' }]
      }
    }
    const payloadFile = join(root, 'admission.json')
    const invoke = () =>
      Bun.spawnSync(
        [
          process.execPath,
          `${import.meta.dir}/../scripts/main.ts`,
          'record',
          '--sdd',
          sdd,
          '--role',
          'coordinator',
          '--expected-state',
          'CONTRACT_DRAFT',
          '--expected-revision',
          'v1',
          '--type',
          'contract_admission',
          '--payload-json',
          readFileSync(payloadFile, 'utf8')
        ],
        { env: { ...process.env, SDD_LOOP_COORDINATOR_TOKEN: 'token' } }
      )
    const reset = () => {
      writeFileSync(sdd, migratedSource)
      writeFileSync(sdd + '.loop.json', JSON.stringify(migratedInitial))
      writeFileSync(sdd + '.events.jsonl', '')
      writeFileSync(payloadFile, JSON.stringify(admission))
    }
    reset()
    let result = invoke()
    expect(result.stderr.toString()).toBe('')
    expect(result.exitCode).toBe(0)
    const admitted = JSON.parse(readFileSync(sdd + '.events.jsonl', 'utf8'))
    expect(admitted.type).toBe('contract_admission')
    expect(admitted.payload.migration_closure.cutover_mode).toBe('COORDINATED_ATOMIC')
    // Same graph is not a staged migration: reader and removal share one packet.
    admission.migration_closure.cutover_mode = 'STAGED'
    reset()
    result = invoke()
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('MIGRATION_READER_NOT_ORDERED_BEFORE_REMOVAL')
    expect(readFileSync(sdd, 'utf8')).toBe(migratedSource)
    expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(JSON.stringify(migratedInitial))
    expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe('')
    expect(readdirSync(root).sort()).toEqual([
      'admission.json',
      'sdd.md',
      'sdd.md.events.jsonl',
      'sdd.md.loop.json'
    ])
    // An up-to-date source hash cannot make an incomplete sensitivity plan valid.
    const malformed = JSON.parse(JSON.stringify(migrated))
    malformed.acceptance[1].oracle_sensitivity.restoration_method = ''
    const malformedSource = `<!-- sdd-contract:start -->\n\`\`\`json\n${JSON.stringify(malformed)}\n\`\`\`\n<!-- sdd-contract:end -->`
    const malformedState = JSON.stringify({
      ...migratedInitial,
      sdd_fingerprint: createHash('sha256').update(malformedSource).digest('hex')
    })
    admission.migration_closure.cutover_mode = 'COORDINATED_ATOMIC'
    writeFileSync(payloadFile, JSON.stringify(admission))
    writeFileSync(sdd, malformedSource)
    writeFileSync(sdd + '.loop.json', malformedState)
    result = invoke()
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('ORACLE_SENSITIVITY_PROCEDURE_REQUIRED')
    expect(readFileSync(sdd, 'utf8')).toBe(malformedSource)
    expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(malformedState)
    expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe('')
    // Continuation may admit repair without pretending the inherited failure
    // already passed. Omitting that obligation must reject before any write.
    const continued = { ...migrated, lineage: { mode: 'continuation' } }
    const continuedSource = `<!-- sdd-contract:start -->\n\`\`\`json\n${JSON.stringify(continued)}\n\`\`\`\n<!-- sdd-contract:end -->`
    const continuedState = JSON.stringify({
      ...migratedInitial,
      sdd_fingerprint: createHash('sha256').update(continuedSource).digest('hex'),
      lineage_obligations: [
        {
          id: 'OB01',
          affected_packages: ['src'],
          kind: 'NON_PASS_VERIFICATION',
          resolution_method: 'cancel-probe',
          source_acceptance: [migrated.acceptance[1]]
        }
      ]
    })
    const continuedPayload = {
      ...admission,
      fact_closure: {
        ...admission.fact_closure,
        lineage_mode: 'continuation',
        inherited_obligations: [
          {
            obligation_id: 'OB01',
            disposition: 'ADMITTED_REPAIR',
            fact_ids: [],
            requirement_ids: ['XQ01'],
            acceptance_ids: ['YS02'],
            repair_packages: ['src'],
            decision_requirement_ids: [],
            evidence: ['the cancellation repair covers the inherited completion failure']
          }
        ]
      }
    }
    const resetContinuation = () => {
      writeFileSync(sdd, continuedSource)
      writeFileSync(sdd + '.loop.json', continuedState)
      writeFileSync(sdd + '.events.jsonl', '')
      writeFileSync(payloadFile, JSON.stringify(continuedPayload))
    }
    resetContinuation()
    result = invoke()
    expect(result.stderr.toString()).toBe('')
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(readFileSync(sdd + '.loop.json', 'utf8')).lineage_obligations).toEqual(
      JSON.parse(continuedState).lineage_obligations
    )
    continuedPayload.fact_closure.inherited_obligations = []
    resetContinuation()
    result = invoke()
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('ADMISSION_INHERITED_OBLIGATION_SCOPE_INVALID')
    expect(readFileSync(sdd, 'utf8')).toBe(continuedSource)
    expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(continuedState)
    expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe('')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

import {
  assertDesignConvergence,
  assertImplementationGraph
} from '../scripts/domain/policies/delivery-graph'

/** Loosely typed contract fixture so each case can mutate one field. */
// oxlint-disable-next-line typescript/no-explicit-any
type IGraph = Record<string, any>

/** Two paths: LJ02 consumes LJ01's store; PC02 lands after PC01. */
const deliveryGraph = () =>
  ({
    revision: 'v1',
    requirements: [
      { id: 'XQ01', kind: 'must-ship', title: 'store', acceptance: ['YS01'] },
      { id: 'XQ02', kind: 'must-ship', title: 'view', acceptance: ['YS02'] }
    ],
    implementation_logic: {
      paths: [
        {
          id: 'LJ01',
          requirement_ids: ['XQ01'],
          acceptance_ids: ['YS01'],
          inputs: [{ name: 'request', source: 'ENTRY', evidence: ['caller supplies request'] }],
          steps: [{ id: 'BZ01', requires: ['request'], produces: ['store'] }],
          outputs: ['store']
        },
        {
          id: 'LJ02',
          requirement_ids: ['XQ02'],
          acceptance_ids: ['YS02'],
          inputs: [{ name: 'store', source: { path: 'LJ01', output: 'store' } }],
          steps: [{ id: 'BZ02', requires: ['store'], produces: ['view'] }],
          outputs: ['view']
        }
      ]
    },
    delivery_plan: {
      batches: [
        { id: 'PC01', requirement_ids: ['XQ01'], acceptance_ids: ['YS01'], depends_on: [] },
        { id: 'PC02', requirement_ids: ['XQ02'], acceptance_ids: ['YS02'], depends_on: ['PC01'] }
      ]
    }
  }) as IGraph

test('implementation paths bind every consumed value to a producer that lands first', () => {
  expect(() => assertImplementationGraph(deliveryGraph() as unknown as Contract)).not.toThrow()
  const renamed = deliveryGraph()
  renamed.implementation_logic.paths[1].steps[0].produces = ['result']
  renamed.implementation_logic.paths[1].outputs = ['result']
  expect(() => assertImplementationGraph(renamed as unknown as Contract)).not.toThrow()
  const cases: [(graph: IGraph) => void, string][] = [
    [
      (g) => (g.implementation_logic.paths[1].steps[0].requires = ['cache']),
      'IMPLEMENTATION_LOGIC_PRODUCER_MISSING'
    ],
    [
      (g) => (g.implementation_logic.paths[0].inputs[0].evidence = []),
      'IMPLEMENTATION_LOGIC_ENTRY_EVIDENCE_REQUIRED'
    ],
    [
      (g) => (g.implementation_logic.paths[1].inputs[0].source = { path: 'LJ09', output: 'store' }),
      'IMPLEMENTATION_LOGIC_INPUT_SOURCE_INVALID'
    ],
    [
      (g) => (g.implementation_logic.paths[1].inputs[0].source = { path: 'LJ01', output: 'cache' }),
      'IMPLEMENTATION_LOGIC_PRODUCER_OUTPUT_MISSING'
    ],
    [
      (g) =>
        g.implementation_logic.paths[0].inputs.push({
          name: 'view',
          source: { path: 'LJ02', output: 'view' }
        }),
      'IMPLEMENTATION_LOGIC_PATH_CYCLE'
    ],
    [
      (g) => {
        g.delivery_plan.batches[0].depends_on = ['PC02']
        g.delivery_plan.batches[1].depends_on = []
      },
      'IMPLEMENTATION_LOGIC_PRODUCER_AFTER_CONSUMER'
    ],
    [
      (g) => {
        g.delivery_plan.batches[0].acceptance_ids = ['YS01', 'YS02']
        g.delivery_plan.batches[1].acceptance_ids = []
      },
      'IMPLEMENTATION_LOGIC_ACCEPTANCE_BEFORE_PRODUCER'
    ]
  ]
  for (const [mutate, code] of cases) {
    const graph = deliveryGraph()
    mutate(graph)
    expect(() => assertImplementationGraph(graph as unknown as Contract)).toThrow(code)
  }
  const shadow = deliveryGraph()
  shadow.implementation_logic.paths[1].inputs[0] = {
    name: 'store',
    source: 'ENTRY',
    evidence: ['produced by LJ01']
  }
  expect(() => assertImplementationGraph(shadow as unknown as Contract)).toThrow(
    'IMPLEMENTATION_LOGIC_ENTRY_SHADOWS_PRODUCER: LJ02.store<-LJ01'
  )
  shadow.implementation_logic.paths[1].inputs[0].independent_of_outputs = true
  expect(() => assertImplementationGraph(shadow as unknown as Contract)).not.toThrow()
  const legacy = deliveryGraph()
  for (const path of legacy.implementation_logic.paths) path.steps = [{ id: `${path.id}-S` }]
  expect(() => assertImplementationGraph(legacy as unknown as Contract)).not.toThrow()
})

test('a contract claiming convergence agrees with its own open lists, reviews and challenges', () => {
  const converged = () => {
    const graph = deliveryGraph()
    for (const path of graph.implementation_logic.paths)
      path.challenges = [{ premise: 'p', result: 'CLOSED', evidence: ['probe.log'] }]
    graph.design_convergence = {
      status: 'CONVERGED',
      unresolved_information_questions: [],
      pending_authority_confirmations: [],
      route_critical_unknowns: [],
      blocking_findings: [],
      material_findings: [],
      stable_after_last_normative_change: true,
      review_passes: ['SYNTHESIS', 'ADVERSARIAL', 'ACCEPTANCE_TOPOLOGY'].map((lens) => ({
        lens,
        result: 'PASS',
        evidence: 'review'
      }))
    }
    return graph
  }
  expect(() => assertDesignConvergence(converged() as unknown as Contract)).not.toThrow()
  const draft = deliveryGraph()
  draft.design_convergence = {
    status: 'IN_REVIEW',
    review_passes: [],
    route_critical_unknowns: ['browser behavior unobserved']
  }
  expect(() => assertDesignConvergence(draft as unknown as Contract)).not.toThrow()
  const cases: [(graph: IGraph) => void, string][] = [
    [
      (g) => (g.design_convergence.route_critical_unknowns = ['api unverified']),
      'DESIGN_CONVERGENCE_INCONSISTENT: route_critical_unknowns'
    ],
    [
      (g) => (g.design_convergence.review_passes = g.design_convergence.review_passes.slice(1)),
      'DESIGN_CONVERGENCE_INCONSISTENT: SYNTHESIS'
    ],
    [
      (g) => (g.implementation_logic.paths[0].challenges = []),
      'DESIGN_CONVERGENCE_CHALLENGE_REQUIRED'
    ],
    [
      (g) => (g.implementation_logic.paths[1].challenges[0].result = 'OPEN'),
      'DESIGN_CONVERGENCE_CHALLENGE_OPEN'
    ]
  ]
  for (const [mutate, code] of cases) {
    const graph = converged()
    mutate(graph)
    expect(() => assertDesignConvergence(graph as unknown as Contract)).toThrow(code)
  }
})
