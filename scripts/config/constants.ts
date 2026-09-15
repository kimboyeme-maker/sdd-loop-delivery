export const PROTOCOL = 'sdd-loop-delivery/v1' as const
/**
 * Default test thresholds. An acceptance-bound rationale may exceed these defaults at
 * admission; runtime execution remains bounded by the admitted budget and lease deadline.
 */
export const TEST_BUDGET_MAX_MINUTES = 15
export const TEST_BUDGET_MAX_SHARE_DIVISOR = 3
export const MAX_NEW_TEST_FILES_PER_BATCH = 1
export const TEST_RETRY_BUDGET_MULTIPLIER = 2
/** Default acceptance timeout ceiling; a contract may justify a larger finite timeout. */
export const ACCEPTANCE_TIMEOUT_MAX_SECONDS = 900
/**
 * Relative credit units charged by the controller. They approximate model spend per grant,
 * not billed tokens: a standard lease costs three units, a mechanical lease or grant one,
 * and each started minute of controller-measured test execution one.
 */
/** Consecutive rejections or stagnant attempts that justify the escalated Operator profile. */
export const ESCALATED_OPERATOR_MIN_FAILURES = 2
export const CREDIT_WEIGHTS: Readonly<Record<string, number>> = {
  operator_standard: 3,
  operator_bounded: 1,
  operator_escalated: 5,
  architect: 3,
  design_counsel: 3,
  repair_probe: 1,
  preparation: 1,
  test_minute: 1
}
/** Default credit budget per admitted round when init names none. */
/** Default tokens per credit unit for host Goal budgets until a token ledger calibrates it. */
export const TOKENS_PER_CREDIT_UNIT = 20_000
export const DEFAULT_CREDIT_BUDGET_PER_ROUND = 60
/** Most recent events a Coordinator brief lists (identifiers only, never payloads). */
export const COORDINATOR_BRIEF_RECENT_EVENTS = 8
/** Bytes of combined test output kept in a test_run event; the full output is only hashed. */
export const TEST_RUN_OUTPUT_TAIL_BYTES = 2000
export const RUNTIME = 'bun' as const
export const MINIMUM_BUN = '1.4.2' as const
export const TYPESCRIPT = '>=7' as const
export const ROLES = ['Supervisor', 'Coordinator', 'Operator', 'Architect'] as const
export type Role = (typeof ROLES)[number]
/** Stable SDD object identities; runtime event and lease IDs use their own protocols. */
export const SDD_DOCUMENT_ID_PATTERN = '^[A-Z]{2}[0-9]{2,4}$'
export const SDD_DEFAULT_ID_PREFIXES: Readonly<Record<string, string>> = {
  PC: 'batch',
  JZ: 'matrix',
  BH: 'closure',
  MJ: 'gate',
  XQ: 'requirement',
  YS: 'acceptance',
  JC: 'decision',
  FX: 'risk',
  LJ: 'implementation_path',
  BZ: 'implementation_step',
  DL: 'claim',
  SP: 'design_review',
  YL: 'legacy_surface',
  DY: 'reader',
  ZJ: 'evidence'
}
/** Runtime removal requires an observable behavior/contract/invocation oracle. */
export const RUNTIME_REMOVAL_CLAIM_DIMENSIONS: readonly string[] = [
  'BEHAVIOR',
  'PUBLIC_CONTRACT',
  'RUNTIME_INVOCATION'
]
/** Source inventory evidence closes the reader universe, not runtime behavior. */
export const READER_INVENTORY_EVIDENCE_KINDS: readonly string[] = [
  'SOURCE_INSPECTION',
  'DEPENDENCY_GRAPH'
]
/** Evidence categories that can support each normative claim dimension. */
export const EVIDENCE_KINDS_BY_CLAIM: Readonly<Record<string, readonly string[]>> = {
  EXECUTION_AUTHORITY: ['BUILD_OUTPUT', 'RUNTIME_TRACE', 'SOURCE_INSPECTION'],
  DIRECT_DEPENDENCY: ['MANIFEST'],
  TRANSITIVE_DEPENDENCY: ['LOCK_GRAPH', 'INSTALLED_GRAPH'],
  CONFIGURATION: ['CONFIG_SOURCE', 'SOURCE_INSPECTION'],
  RUNTIME_INVOCATION: ['RUNTIME_TRACE', 'BUILD_OUTPUT'],
  BUILD_OUTPUT: ['BUILD_OUTPUT'],
  BEHAVIOR: ['TEST_RESULT', 'RUNTIME_TRACE'],
  PUBLIC_CONTRACT: ['TYPECHECK', 'PACKED_CONSUMER', 'SOURCE_INSPECTION'],
  ARCHITECTURE: ['SOURCE_INSPECTION', 'DEPENDENCY_GRAPH']
}
/** Whole-contract decisions that must be closed before route admission. */
export const DECISION_CLOSURE_DIMENSIONS = [
  'SEMANTIC_OWNER',
  'DEPENDENCY_DIRECTION',
  'PUBLIC_CONTRACT',
  'DIRECT_CONSUMERS',
  'USER_AUTHORITY'
] as const
/** Permitted assumption categories for independent route admission evidence. */
export const ADMISSION_ASSUMPTION_CATEGORIES = [
  'OWNERSHIP',
  'DEPENDENCY_DIRECTION',
  'PUBLIC_CONTRACT',
  'DIRECT_CONSUMER',
  'MIGRATION_READER_CLOSURE',
  'ROUTE_FEASIBILITY',
  'ACCEPTANCE_EXECUTABILITY',
  'AUTHORITY',
  'ARTIFACT_CUSTODY'
] as const

/** Required lenses for design repair proposals and Coordinator review. */
export const DESIGN_REVIEW_DIMENSIONS = [
  'STATE_EVIDENCE_LIFECYCLE',
  'PACKET_DEPENDENCY',
  'SCOPE_AUTHORITY',
  'VERIFICATION_TOPOLOGY',
  'FAILURE_RECOVERY'
] as const
/** Real user-authority boundaries; ordinary technical route choices never qualify. */
export const USER_AUTHORITY_BASES = [
  'MUST_SHIP_SCOPE_CHANGE',
  'MUST_SHIP_DEFERRAL',
  'MATERIAL_SECURITY_OR_DATA_RISK',
  'PUBLIC_API_BREAK',
  'MAJOR_OWNERSHIP_MOVE',
  'BEHAVIOR_DELETION',
  'IRREVERSIBLE_OR_EXTERNAL_ACTION',
  'USER_RESERVED_PRODUCT_CHOICE'
] as const
/** Complete boolean authority delta of a user-decision request, keyed by crossed effect. */
export const AUTHORITY_DELTA_KEYS = [
  'must_ship_scope_change',
  'must_ship_deferral',
  'material_security_or_data_risk',
  'public_api_break',
  'major_ownership_move',
  'behavior_deletion',
  'irreversible_effect',
  'external_effect',
  'user_reserved_product_choice'
] as const
/** The selected basis must correspond to at least one true delta effect. */
export const AUTHORITY_BASIS_DELTA_KEYS: Readonly<
  Record<(typeof USER_AUTHORITY_BASES)[number], readonly (typeof AUTHORITY_DELTA_KEYS)[number][]>
> = {
  MUST_SHIP_SCOPE_CHANGE: ['must_ship_scope_change'],
  MUST_SHIP_DEFERRAL: ['must_ship_deferral'],
  MATERIAL_SECURITY_OR_DATA_RISK: ['material_security_or_data_risk'],
  PUBLIC_API_BREAK: ['public_api_break'],
  MAJOR_OWNERSHIP_MOVE: ['major_ownership_move'],
  BEHAVIOR_DELETION: ['behavior_deletion'],
  IRREVERSIBLE_OR_EXTERNAL_ACTION: ['irreversible_effect', 'external_effect'],
  USER_RESERVED_PRODUCT_CHOICE: ['user_reserved_product_choice']
}
/** Protected artifact kinds that need an executable custody chain before ADMIT. */
export const ARTIFACT_KINDS = [
  'SIGNED',
  'GENERATED',
  'APPROVED_PROTECTED',
  'INTEGRITY_BOUND'
] as const
/** Custody stage owners; `none` marks an absent stage such as an unsigned artifact. */
export const ARTIFACT_ROLES = [
  'coordinator',
  'operator',
  'architect',
  'repository_tool',
  'none'
] as const
/** Installer role → the only install mode it may declare. */
export const ARTIFACT_INSTALL_MODES: Readonly<Record<string, string>> = {
  coordinator: 'BYTE_EXACT_CUSTODY_INSTALL',
  operator: 'IMPLEMENTATION_WRITE',
  repository_tool: 'TOOL_MANAGED_INSTALL'
}
/** Enumerated product/control-authority causes for terminal BLOCKED; user waits are excluded. */
export const TERMINAL_BLOCKER_REASONS = [
  'REQUIRED_RUNTIME_UNAVAILABLE',
  'REQUIRED_TOOL_UNAVAILABLE',
  'NO_FEASIBLE_SAFE_ROUTE',
  'INCONCLUSIVE_MUST_SHIP_AFTER_BOUNDED_ATTEMPTS',
  'COORDINATOR_AUTHORITY_UNRECOVERABLE'
] as const
/** Enumerated reasons that justify dispatching a distinct Architect instead of reusing the current one. */
export const FRESH_ARCHITECT_REASONS: readonly string[] = [
  'material-contract-or-architecture-change',
  'capability-or-authority-incident',
  'prior-architect-unavailable-or-timed-out',
  'verification-quality-or-anchoring-failure',
  'explicit-user-or-sdd-independent-verifier',
  'design-counsel-participation',
  // A distinct Architect verifying another planned final-verification shard concurrently.
  'parallel-final-verification-shard'
]
/** Coordinator dispositions for one Architect Finding; exactly one is recorded per Finding. */
export const FINDING_DECISIONS = [
  'APPROVE_AS_PROPOSED',
  'APPROVE_WITH_EXISTING_CAPABILITY',
  'REWRITE_ROUTE',
  'SPLIT_ROUTE',
  'DEFER_WITH_CONTAINMENT',
  'DOWNGRADE_TO_P3_OR_P4',
  'REJECT_FINDING_OR_PROPOSAL',
  'BLOCKED_NEEDS_USER_DECISION'
] as const
/** decision-evidence-v1 vocabulary for Coordinator review of decision-relevant Architect claims. */
export const DECISION_EVIDENCE = {
  claimTypes: [
    'STATIC_FACT',
    'CANONICAL_ORACLE',
    'BEHAVIOR',
    'ROOT_CAUSE',
    'PROPOSED_ROUTE',
    'ACCEPTANCE_VERDICT'
  ],
  impacts: [
    'NON_DECISIVE',
    'LOCAL',
    'ROUTE_CHANGING',
    'SCOPE_OR_AUTHORITY',
    'REQUIREMENT_STATUS',
    'TERMINAL'
  ],
  /** Impacts where an INCONCLUSIVE result cannot support the decision. */
  materialImpacts: ['ROUTE_CHANGING', 'SCOPE_OR_AUTHORITY', 'REQUIREMENT_STATUS', 'TERMINAL'],
  methods: [
    'SOURCE_READ',
    'ARTIFACT_AUDIT',
    'TARGETED_REPRODUCTION',
    'COUNTERFACTUAL',
    'CANONICAL_ORACLE'
  ],
  /** Inspection-only methods; they require one enumerated reason for not rerunning. */
  inspectionMethods: ['SOURCE_READ', 'ARTIFACT_AUDIT'],
  noRerunReasons: [
    'STATIC_FACT_DIRECTLY_READ',
    'CANONICAL_ORACLE_ALREADY_INDEPENDENT',
    'HASH_OR_IDENTITY_PROOF',
    'NON_DECISIVE_ADVISORY',
    'EDITORIAL_OR_MECHANICAL'
  ],
  results: ['CONFIRMED', 'DISPROVED', 'INCONCLUSIVE']
} as const

/** User-controlled boundaries a design proposal must explicitly preserve or escalate. */
export const DESIGN_PRESERVATION_BOUNDARIES = [
  'objective',
  'must_ship_scope',
  'modification_authority',
  'public_contract_and_behavior',
  'security_and_data_risk',
  'irreversible_or_external_effects',
  'user_reserved_product_choice'
] as const
