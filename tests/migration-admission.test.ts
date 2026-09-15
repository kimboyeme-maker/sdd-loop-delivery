import { expect, test } from 'bun:test'
import {
  assertMigrationAdmission,
  migrationInventory
} from '../scripts/domain/policies/migration-admission'
import type { Contract } from '../scripts/domain/contract'

/** A retained public entry invokes the new handler after its old consumer is migrated. */
function fixture() {
  const contract = {
    revision: 'v1',
    requirements: [
      { id: 'XQ01', kind: 'must-ship', title: 'migrate consumer', acceptance: ['YS01'] },
      { id: 'XQ02', kind: 'must-ship', title: 'remove old handler', acceptance: ['YS02'] }
    ],
    acceptance: [
      { id: 'YS01', claim: { id: 'CL01', dimension: 'BEHAVIOR', quantifier: 'SINGLE' } },
      {
        id: 'YS02',
        claim: {
          id: 'CL02',
          dimension: 'BEHAVIOR',
          quantifier: 'UNIVERSAL',
          universe: ['public entry', 'consumer']
        },
        oracle_sensitivity: { applicability: 'REQUIRED' }
      }
    ],
    migration_applicability: 'REQUIRED',
    migration: {
      inventory_roots: ['src'],
      inventory_method: 'scan retained entry and consumer',
      inventory_evidence: ['inventory output'],
      unknown_readers: [] as string[],
      legacy_surfaces: [
        {
          id: 'LS01',
          owner: 'old-handler',
          symbols: ['oldDispatch'],
          final_disposition: 'REMOVE',
          requirement_ids: ['XQ02'],
          acceptance_ids: ['YS02'],
          zero_reader_acceptance_ids: ['YS02']
        }
      ],
      readers: [
        {
          id: 'RD01',
          module: 'consumer',
          edge: 'consumer calls oldDispatch',
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
  } satisfies Contract
  const packet = {
    outcome: 'switch owner',
    preconditions: ['owner available'],
    causal_scope: ['dispatch'],
    stop_or_escalate: ['ownership differs']
  }
  const payload = {
    requirement_ids: ['XQ01', 'XQ02'],
    acceptance_ids: ['YS01', 'YS02'],
    execution_packets: [
      {
        ...packet,
        id: 'PC01',
        requirement_ids: ['XQ01'],
        acceptance_ids: ['YS01'],
        depends_on_packet_ids: [] as string[]
      },
      {
        ...packet,
        id: 'PC02',
        requirement_ids: ['XQ02'],
        acceptance_ids: ['YS02'],
        depends_on_packet_ids: ['PC01']
      }
    ],
    fact_closure: {
      facts: [
        {
          id: 'FT01',
          status: 'CONFIRMED_PASS',
          evidence_kind: 'SOURCE_INSPECTION',
          covered_universe: ['public entry', 'consumer']
        }
      ]
    },
    assumptions_checked: [{ id: 'AS01', category: 'MIGRATION_READER_CLOSURE' }],
    early_falsifier_result: {
      probe_kind: 'MIGRATION_READER_INVENTORY',
      method: contract.migration.inventory_method,
      target_assumption_ids: ['AS01'],
      evidence_fact_ids: ['FT01']
    },
    migration_closure: {
      applicability: 'REQUIRED',
      unresolved_reader_ids: [] as string[],
      cutover_mode: 'STAGED',
      inventory_fact_ids: ['FT01'],
      legacy_runtime_authority: [
        {
          legacy_surface_id: 'LS01',
          applicability: 'REQUIRED',
          evidence: ['retained entry runtime probe'],
          acceptance_ids: ['YS02'],
          forbidden_behavior: 'old handler remains executable',
          probe_method: 'invoke retained public entry with independent fixture',
          observed_result: 'new handler invoked once; old handler never invoked',
          oracle_independence: 'INDEPENDENT_FIXTURE',
          reason: ''
        }
      ],
      reader_packet_bindings: [{ reader_id: 'RD01', packet_id: 'PC01' }],
      removal_packet_bindings: [{ legacy_surface_id: 'LS01', packet_id: 'PC02' }],
      atomicity_evidence: [] as string[]
    }
  }
  return { contract, payload }
}

test('staged migration orders reader before removal, including transitive packet paths', () => {
  const { contract, payload } = fixture()
  const before = JSON.stringify({ contract, payload })
  expect(() => assertMigrationAdmission(contract, payload)).not.toThrow()
  expect(JSON.stringify({ contract, payload })).toBe(before)
  payload.execution_packets.push({
    ...payload.execution_packets[0]!,
    id: 'PC03',
    depends_on_packet_ids: ['PC01']
  })
  payload.execution_packets[1]!.depends_on_packet_ids = ['PC03']
  expect(() => assertMigrationAdmission(contract, payload)).not.toThrow()
  payload.execution_packets[1]!.depends_on_packet_ids = []
  expect(() => assertMigrationAdmission(contract, payload)).toThrow(
    'MIGRATION_READER_NOT_ORDERED_BEFORE_REMOVAL'
  )
})

test('a shared packet requires coordinated atomic evidence instead of pretending staged order', () => {
  const { contract, payload } = fixture()
  payload.execution_packets = [
    {
      ...payload.execution_packets[0]!,
      requirement_ids: ['XQ01', 'XQ02'],
      acceptance_ids: ['YS01', 'YS02']
    }
  ]
  payload.migration_closure.removal_packet_bindings[0]!.packet_id = 'PC01'
  expect(() => assertMigrationAdmission(contract, payload)).toThrow(
    'MIGRATION_READER_NOT_ORDERED_BEFORE_REMOVAL'
  )
  payload.migration_closure.cutover_mode = 'COORDINATED_ATOMIC'
  expect(() => assertMigrationAdmission(contract, payload)).toThrow(
    'MIGRATION_ATOMICITY_EVIDENCE_REQUIRED'
  )
  payload.migration_closure.atomicity_evidence = [
    'all consumers and removal share one candidate; no intermediate deployment'
  ]
  expect(() => assertMigrationAdmission(contract, payload)).not.toThrow()
})

test('reader/removal bindings reject unknown, omitted, duplicate and incorrectly scoped entries', () => {
  const mutations: [string, (value: ReturnType<typeof fixture>) => void][] = [
    [
      'MIGRATION_READER_PACKET_SCOPE_INVALID',
      ({ payload }) => {
        payload.migration_closure.reader_packet_bindings = []
      }
    ],
    [
      'MIGRATION_READER_PACKET_BINDING_INVALID',
      ({ payload }) => {
        payload.migration_closure.reader_packet_bindings.push(
          payload.migration_closure.reader_packet_bindings[0]!
        )
      }
    ],
    [
      'MIGRATION_REMOVAL_PACKET_SCOPE_INVALID',
      ({ payload }) => {
        payload.migration_closure.removal_packet_bindings = []
      }
    ],
    [
      'MIGRATION_REMOVAL_PACKET_BINDING_INVALID',
      ({ payload }) => {
        payload.migration_closure.removal_packet_bindings.push(
          payload.migration_closure.removal_packet_bindings[0]!
        )
      }
    ],
    [
      'MIGRATION_READER_PACKET_UNKNOWN',
      ({ payload }) => {
        payload.migration_closure.reader_packet_bindings[0]!.packet_id = 'PC99'
      }
    ],
    [
      'MIGRATION_REMOVAL_PACKET_UNKNOWN',
      ({ payload }) => {
        payload.migration_closure.removal_packet_bindings[0]!.packet_id = 'PC99'
      }
    ],
    [
      'MIGRATION_READER_PACKET_COVERAGE_INVALID',
      ({ payload }) => {
        payload.migration_closure.reader_packet_bindings[0]!.packet_id = 'PC02'
      }
    ],
    [
      'MIGRATION_REMOVAL_PACKET_COVERAGE_INVALID',
      ({ payload }) => {
        payload.migration_closure.cutover_mode = 'COORDINATED_ATOMIC'
        payload.migration_closure.removal_packet_bindings[0]!.packet_id = 'PC01'
      }
    ]
  ]
  for (const [code, mutate] of mutations) {
    const value = fixture()
    expect(() => assertMigrationAdmission(value.contract, value.payload)).not.toThrow()
    mutate(value)
    expect(() => assertMigrationAdmission(value.contract, value.payload)).toThrow(code)
  }
})

test('inventory does not replace runtime proof or vice versa', () => {
  const mutations: [string, (value: ReturnType<typeof fixture>) => void][] = [
    [
      'MIGRATION_INVENTORY_FACT_NOT_PASS',
      ({ payload }) => {
        payload.fact_closure.facts[0]!.status = 'CONFIRMED_FAIL'
      }
    ],
    [
      'MIGRATION_EARLY_FALSIFIER_MISMATCH',
      ({ payload }) => {
        payload.early_falsifier_result.method = 'different scan'
      }
    ],
    [
      'MIGRATION_EARLY_FALSIFIER_MISMATCH',
      ({ payload }) => {
        payload.early_falsifier_result.evidence_fact_ids = ['FT99']
      }
    ],
    [
      'MIGRATION_EARLY_FALSIFIER_MISMATCH',
      ({ payload }) => {
        payload.assumptions_checked[0]!.category = 'ROUTE_FEASIBILITY'
      }
    ],
    [
      'MIGRATION_REFINED_ZERO_READER_RUNTIME_PROOF_REQUIRED',
      ({ payload }) => {
        payload.migration_closure.legacy_runtime_authority[0]!.applicability = 'NOT_APPLICABLE'
      }
    ],
    [
      'MIGRATION_REFINED_ZERO_READER_INVENTORY_INCOMPLETE',
      ({ payload }) => {
        payload.fact_closure.facts[0]!.covered_universe = ['consumer']
      }
    ],
    [
      'MIGRATION_REFINED_ZERO_READER_INVENTORY_INCOMPLETE',
      ({ payload }) => {
        payload.fact_closure.facts[0]!.evidence_kind = 'TEST_RESULT'
      }
    ],
    [
      'MIGRATION_LEGACY_RUNTIME_PROBE_INVALID',
      ({ payload }) => {
        payload.migration_closure.legacy_runtime_authority[0]!.oracle_independence = 'SELF_REPORT'
      }
    ],
    [
      'MIGRATION_LEGACY_RUNTIME_PROBE_INVALID',
      ({ payload }) => {
        payload.migration_closure.legacy_runtime_authority[0]!.observed_result = ''
      }
    ],
    [
      'MIGRATION_LEGACY_RUNTIME_AUTHORITY_SCOPE_INVALID',
      ({ payload }) => {
        payload.migration_closure.legacy_runtime_authority = []
      }
    ],
    [
      'MIGRATION_READER_CLOSURE_UNRESOLVED',
      ({ payload }) => {
        payload.migration_closure.unresolved_reader_ids = ['RD99']
      }
    ]
  ]
  for (const [code, mutate] of mutations) {
    const value = fixture()
    expect(() => assertMigrationAdmission(value.contract, value.payload)).not.toThrow()
    mutate(value)
    expect(() => assertMigrationAdmission(value.contract, value.payload)).toThrow(code)
  }
})

test('migration document closes references, source universe and retained-reader semantics', () => {
  const mutations: [string, (value: ReturnType<typeof fixture>) => void][] = [
    [
      'MIGRATION_CONTRACT_INVALID',
      ({ contract }) => {
        contract.migration.unknown_readers = ['unlocated import']
      }
    ],
    [
      'MIGRATION_CONTRACT_INVALID',
      ({ contract }) => {
        contract.migration.legacy_surfaces.push(contract.migration.legacy_surfaces[0]!)
      }
    ],
    [
      'MIGRATION_CONTRACT_SCOPE_INVALID',
      ({ contract }) => {
        contract.migration.readers[0]!.legacy_surface_ids = ['LS99']
      }
    ],
    [
      'MIGRATION_CONTRACT_SCOPE_INVALID',
      ({ contract }) => {
        contract.migration.legacy_surfaces[0]!.requirement_ids = ['XQ99']
      }
    ],
    [
      'MIGRATION_READER_RETAINS_REMOVED_SURFACE',
      ({ contract }) => {
        contract.migration.readers[0]!.disposition = 'RETAIN_COMPATIBILITY'
      }
    ],
    [
      'MIGRATION_ZERO_READER_CLAIM_INVALID',
      ({ contract }) => {
        contract.acceptance[1]!.claim.quantifier = 'SINGLE'
      }
    ],
    [
      'MIGRATION_ZERO_READER_CLAIM_INVALID',
      ({ contract }) => {
        contract.acceptance[1]!.oracle_sensitivity = { applicability: 'NOT_APPLICABLE' }
      }
    ]
  ]
  for (const [code, mutate] of mutations) {
    const value = fixture()
    expect(() => migrationInventory(value.contract)).not.toThrow()
    mutate(value)
    expect(() => migrationInventory(value.contract)).toThrow(code)
  }
})

test('a source-only removal may explain runtime non-applicability; retained surfaces need no removal packet', () => {
  const { contract, payload } = fixture()
  contract.acceptance[1]!.claim.dimension = 'ARCHITECTURE'
  payload.migration_closure.legacy_runtime_authority[0]!.applicability = 'NOT_APPLICABLE'
  payload.migration_closure.legacy_runtime_authority[0]!.acceptance_ids = []
  expect(() => assertMigrationAdmission(contract, payload)).toThrow(
    'MIGRATION_LEGACY_RUNTIME_NOT_APPLICABLE_INVALID'
  )
  payload.migration_closure.legacy_runtime_authority[0]!.reason =
    'type-only obsolete surface has no executable entry'
  expect(() => assertMigrationAdmission(contract, payload)).not.toThrow()
  contract.migration.legacy_surfaces[0]!.final_disposition = 'RETAIN_COMPATIBILITY'
  contract.migration.legacy_surfaces[0]!.zero_reader_acceptance_ids = []
  contract.migration.readers[0]!.disposition = 'RETAIN_COMPATIBILITY'
  payload.migration_closure.legacy_runtime_authority = []
  payload.migration_closure.removal_packet_bindings = []
  expect(() => assertMigrationAdmission(contract, payload)).not.toThrow()
})

test('non-migration work remains legal without fabricated migration tasks', () => {
  const { contract } = fixture()
  const local = { ...contract, migration_applicability: 'NOT_APPLICABLE' }
  expect(() => assertMigrationAdmission(local, {})).not.toThrow()
  expect(() =>
    assertMigrationAdmission(local, {
      migration_closure: { applicability: 'NOT_APPLICABLE', reason: 'no existing entry changes' }
    })
  ).not.toThrow()
  expect(() =>
    assertMigrationAdmission(local, { migration_closure: { applicability: 'REQUIRED' } })
  ).toThrow('MIGRATION_CLOSURE_NOT_APPLICABLE_INVALID')
})
