/**
 * Error-code prefix → category and first remediation. The catalog renderer groups every thrown
 * code by its first segment; an unmapped prefix renders under `other` and is a prompt to map it.
 */
export const ERROR_CATEGORIES: Readonly<
  Record<string, Readonly<{ title: string; prefixes: readonly string[]; remediation: string }>>
> = {
  authority: {
    title: 'Authority and credentials',
    prefixes: [
      'AUTH',
      'AUTHORIZATION',
      'AUTHORITY',
      'BOOTSTRAP',
      'CAPABILITY',
      'COORDINATOR',
      'EPOCH',
      'TOKEN',
      'ROLE',
      'AGENT',
      'TAKEOVER',
      'SUPERVISION',
      'UNAUTHORIZED'
    ],
    remediation:
      'Authenticate with the current capability file (SDD_LOOP_COORDINATOR_TOKEN_FILE or SDD_LOOP_AGENT_TOKEN_FILE). Never mint, copy or print tokens; after an authority rotation use the newly returned file. Role events need the lease and role they were dispatched with.'
  },
  state: {
    title: 'State, concurrency and recovery',
    prefixes: [
      'EXPECTED',
      'CONTROL',
      'LOCK',
      'TRANSACTION',
      'EVENT',
      'STATE',
      'LOOP',
      'PHASE',
      'TRANSITION',
      'ROUND',
      'WORKTREE',
      'PAUSED',
      'CANCELLED',
      'OWNER',
      'PREVIOUS',
      'CROSS',
      'INIT',
      'JOURNAL',
      'RECOVERY',
      'OPEN',
      'CANONICAL',
      'UNKNOWN',
      'DUPLICATE',
      'RECORD',
      'RECEIPT',
      'PAYLOAD',
      'PROCESS',
      'ACTION',
      'FAILED'
    ],
    remediation:
      'Re-anchor on coordinator-brief (or status), then retry with the current --expected-state and --expected-revision. A pending journal or orphan lock follows references/recovery.md; never edit sidecars by hand.'
  },
  contract: {
    title: 'Contract and design',
    prefixes: [
      'CONTRACT',
      'DESIGN',
      'SDD',
      'DOCUMENT',
      'REQUIREMENT',
      'ACCEPTANCE',
      'MUST',
      'ORACLE',
      'SEMANTIC',
      'LINEAGE',
      'MIGRATION',
      'EXPERIENCE',
      'DELIVERY',
      'ARCHITECTURE',
      'PRODUCT',
      'EARLY',
      'CONVERGENCE',
      'IMPLEMENTATION',
      'FACT',
      'CLAIM',
      'NORMATIVE',
      'PRESENTATION',
      'AMEND',
      'SHARED'
    ],
    remediation:
      'The SDD or its contract block is incomplete or inconsistent. Before initialization fix it and rerun validate; during delivery record a scoped amendment. Treat a recurring code as a create-sdd evolution signal.'
  },
  admission: {
    title: 'Admission, packets and scope',
    prefixes: [
      'ADMISSION',
      'EXECUTION',
      'PACKET',
      'SCOPE',
      'OPERATOR',
      'BOUNDED',
      'GUIDANCE',
      'DISPATCH',
      'PREPARATION',
      'PRE',
      'READBACK',
      'CONTEXT',
      'CANDIDATE',
      'PREPARE',
      'RESUME',
      'CHECKPOINT',
      'STANDARD',
      'ARCHITECT',
      'FRESH',
      'DECISION',
      'LEASE',
      'ATTEMPT',
      'ACTIVE',
      'MODIFICATION',
      'SAFE',
      'REPAIR',
      'CONCURRENT',
      'DEDICATED',
      'CREATED',
      'DELETED',
      'WORKSPACE'
    ],
    remediation:
      'Re-derive the packet and lease from the current admission and stay inside its modification_packages. Dispatch, preparation and readback follow references/coordinator.md; an out-of-scope need is an escalation or amendment, never a wider write.'
  },
  verification: {
    title: 'Verification, tests and shipping',
    prefixes: [
      'VERIFICATION',
      'TEST',
      'SELF',
      'FINDING',
      'SHIP',
      'FINAL',
      'READY',
      'HANDOFF',
      'REUSED',
      'CHECK',
      'VERIFIED',
      'PREPARED',
      'INDEPENDENT',
      'BASELINE',
      'AFFECTED',
      'DEFERRAL',
      'DEFERRED'
    ],
    remediation:
      'Run acceptance through test-run and cite its measured events; cover every admitted acceptance with current evidence; exhausted test budgets escalate instead of widening tests (references/execution.md#test-budget).'
  },
  runtime: {
    title: 'Runtime, host and pipeline',
    prefixes: ['RUNTIME', 'HOST', 'PIPELINE', 'ENVIRONMENT', 'IN', 'COMMAND', 'CLI', 'INVOCATION'],
    remediation:
      'Check the active host profile (bun scripts/main.ts configuration) and the recorded runtime facts; pipeline and environment faults go to the pipeline ledger and repair probes, never to product BLOCKED.'
  },
  resources: {
    title: 'Dependencies, artifacts, credit and user decisions',
    prefixes: [
      'DEPENDENCY',
      'ARTIFACT',
      'USER',
      'CREDIT',
      'TERMINAL',
      'RETROSPECTIVE',
      'PROGRAM',
      'FAILURE',
      'MAX',
      'BENCH'
    ],
    remediation:
      'Dependency and artifact operations need their recorded custody and review; credit exhaustion needs user-control extend-credit from the user; user decisions are asked once with a complete authorization request.'
  }
}
