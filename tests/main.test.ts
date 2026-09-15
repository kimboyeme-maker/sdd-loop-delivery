import { contextDocumentPage } from '../scripts/services/context-document'
import { runBootstrapProcesses } from '../scripts/controllers/bootstrap-process'
import { admissionFixture } from './fixtures/admission'
import { rolePublicKey, signRoleEvent } from '../scripts/resource/role-signature'
import { bindEventLog, eventLogBinding } from '../scripts/resource/store/event-log-binding'
import { expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertCurrentLease, createContext } from '../scripts/context/context'
import { commit, recover } from '../scripts/resource/store/transaction'
import { assertLease } from '../scripts/domain/entities/lease'
import { assertPhaseTransition } from '../scripts/domain/policies/phase'
import { transitionPhase } from '../scripts/domain/entities/loop-state'
import { assertPathInScope, normalizeOwner } from '../scripts/domain/policies/scope'
import { planDispatch } from '../scripts/domain/policies/dispatch'
import { assertShip } from '../scripts/domain/policies/ship'
import {
  assertRequirementStatus,
  effectiveMustShipRequirements
} from '../scripts/domain/policies/requirements'
import { assessRuntimeReuse } from '../scripts/domain/policies/runtime'
import { assertReadback } from '../scripts/domain/policies/readback'
import { applyAttemptEvent } from '../scripts/domain/policies/attempt'
import { lintOperatorReceipt } from '../scripts/controllers/receipt.controller'
import { contextRead, runtimeView } from '../scripts/controllers/read-only.controller'
import { snapshotWorktree } from '../scripts/resource/worktree/snapshot'
import { checkEventLog } from '../scripts/resource/store/event-log'
import { COMMANDS } from '../scripts/commands/registry'
import { assertFinding, resolveFinding } from '../scripts/domain/policies/finding'
import { assertBootstrapReceipts } from '../scripts/domain/policies/bootstrap'
import { decodeState, readSnapshot } from '../scripts/resource/state'
import { validateBootstrapPayload } from '../scripts/controllers/bootstrap.controller'
import { commitSidecar, recoverSidecar } from '../scripts/resource/store/sidecar-transaction'
import { transition } from '../scripts/controllers/transition.controller'
import { transactionRecover } from '../scripts/controllers/transaction-recover.controller'
import { lockRecover } from '../scripts/controllers/lock-recover.controller'
import { recordEvent } from '../scripts/controllers/record.controller'
import { userControl } from '../scripts/controllers/user-control.controller'
import { requirementUpdate } from '../scripts/controllers/requirement.controller'
import { findingUpdate } from '../scripts/controllers/finding.controller'
import { authBootstrap } from '../scripts/controllers/auth-bootstrap.controller'
import { dispatch } from '../scripts/controllers/dispatch.controller'
import { initLoop } from '../scripts/controllers/init.controller'
import { attempt } from '../scripts/controllers/attempt.controller'
import { runtimeRecord } from '../scripts/controllers/runtime-record.controller'
import { failure } from '../scripts/controllers/failure.controller'
import { amendContract } from '../scripts/controllers/amend.controller'
import { agentStartReceipt } from '../scripts/controllers/agent-start-receipt.controller'
import { agentRecord } from '../scripts/controllers/agent-record.controller'

test('amend preserves authority and history while revoking obsolete preparation', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-amend-')),
    sdd = join(root, 'task.sdd.md')
  try {
    const fixture = admissionFixture()
    writeFileSync(sdd, fixture.source)
    initLoop(sdd, 3)
    authBootstrap(sdd, 'DISCOVER', 'v1', 'yes', 'coord-secret')
    const path = sdd + '.loop.json',
      state = JSON.parse(readFileSync(path, 'utf8'))
    state.preparation = { prepared_id: 'PREP-obsolete', contract_revision: 'v1' }
    writeFileSync(path, JSON.stringify(state))
    const previousEvents = readFileSync(sdd + '.events.jsonl', 'utf8')
    const revised = { ...fixture.contract, revision: 'v2' }
    writeFileSync(
      sdd,
      fixture.source.replace(JSON.stringify(fixture.contract), JSON.stringify(revised))
    )
    writeFileSync(path, JSON.stringify({ ...state, active_lease: { lease_id: 'still-active' } }))
    const activeBytes = readFileSync(path, 'utf8')
    expect(() =>
      amendContract(sdd, 'coordinator', 'DISCOVER', 'v1', sdd, 'v2', 'clarify flow', 'coord-secret')
    ).toThrow('NO_ACTIVE_LEASE')
    expect(readFileSync(path, 'utf8')).toBe(activeBytes)
    expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe(previousEvents)
    writeFileSync(path, JSON.stringify(state))
    const result = amendContract(
      sdd,
      'coordinator',
      'DISCOVER',
      'v1',
      sdd,
      'v2',
      'clarify flow',
      'coord-secret'
    )
    expect(result.protocol).toBe('amend/v1')
    const next = readSnapshot(sdd).state
    expect(next).toMatchObject({
      phase: 'CONTRACT_AMENDED',
      contract_revision: 'v2',
      preparation: null
    })
    for (const key of [
      'authority_epoch',
      'coordinator_token_hash',
      'coordinator_event_keys',
      'completed_attempts',
      'max_rounds',
      'requirements'
    ])
      expect(next[key]).toEqual(state[key])
    expect(readFileSync(sdd + '.events.jsonl', 'utf8').startsWith(previousEvents)).toBe(true)
    const last = JSON.parse(
      readFileSync(sdd + '.events.jsonl', 'utf8')
        .trim()
        .split('\n')
        .at(-1)!
    )
    expect(last.payload.revoked_prepared_id).toBe('PREP-obsolete')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('new CLI has a deterministic read-only help path', () => {
  const result = Bun.spawnSync([
    process.execPath,
    `${import.meta.dir}/../scripts/main.ts`,
    '--help'
  ])
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toContain('sdd-loop-delivery')
  expect(result.stderr.toString()).toBe('')
})

test('unknown options fail closed instead of being silently ignored', () => {
  const result = Bun.spawnSync([
    process.execPath,
    `${import.meta.dir}/../scripts/main.ts`,
    'status',
    '--phase'
  ])
  expect(result.exitCode).toBe(2)
  expect(result.stderr.toString()).toContain('CLI_OPTION_UNKNOWN:--phase')
})

test('command registry lists each operation once with its mutation class', () => {
  expect(COMMANDS).toHaveLength(47)
  expect(new Set(COMMANDS.map(({ name }) => name)).size).toBe(47)
  expect(COMMANDS.find(({ name }) => name === 'dispatch')?.mutation).toBe(true)
  expect(COMMANDS.find(({ name }) => name === 'status')?.mutation).toBe(false)
})

test('command coverage check pairs every registered command with its branch', () => {
  const result = Bun.spawnSync([
    process.execPath,
    `${import.meta.dir}/../scripts/check-command-coverage.ts`
  ])
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout.toString())).toEqual({
    protocol: 'command-coverage/v1',
    registered: 47
  })
  expect(result.stderr.toString()).toBe('')
})

test('unknown command never claims completion', () => {
  const result = Bun.spawnSync([
    process.execPath,
    `${import.meta.dir}/../scripts/main.ts`,
    'unknown'
  ])
  expect(result.exitCode).toBe(2)
  expect(result.stderr.toString()).toContain('COMMAND_UNKNOWN')
})

test('a command without its required inputs fails closed', () => {
  const result = Bun.spawnSync([
    process.execPath,
    `${import.meta.dir}/../scripts/main.ts`,
    'status'
  ])
  expect(result.exitCode).toBe(2)
  expect(result.stderr.toString()).toContain('SDD_REQUIRED')
})

test('every mutation command rejects an incomplete invocation before writing', () => {
  for (const command of COMMANDS.filter(({ mutation }) => mutation)) {
    const result = Bun.spawnSync([
      process.execPath,
      `${import.meta.dir}/../scripts/main.ts`,
      command.name
    ])
    expect(result.exitCode).toBe(2)
    expect(result.stderr.toString()).not.toContain('Unhandled')
    expect(result.stderr.toString()).not.toContain('TypeError')
  }
})

test('every registered command exposes a read-only subcommand help path', () => {
  for (const command of COMMANDS) {
    const result = Bun.spawnSync([
      process.execPath,
      `${import.meta.dir}/../scripts/main.ts`,
      command.name,
      '--help'
    ])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain(`sdd-loop-delivery ${command.name}`)
  }
})

test('configuration and capabilities are real read-only commands', () => {
  for (const command of ['configuration', 'capabilities']) {
    const result = Bun.spawnSync([
      process.execPath,
      `${import.meta.dir}/../scripts/main.ts`,
      command
    ])
    expect(result.exitCode).toBe(0)
    expect(() => JSON.parse(result.stdout.toString())).not.toThrow()
    expect(result.stderr.toString()).toBe('')
    if (command === 'configuration') {
      const output = JSON.parse(result.stdout.toString()) as {
        protocol: string
        roles: { role: string }[]
      }
      expect(output.protocol).toBe('sdd-loop-delivery/v1')
      expect(output.roles.map(({ role }) => role)).toEqual([
        'Supervisor',
        'Coordinator',
        'Operator',
        'Architect'
      ])
    }
    if (command === 'capabilities') {
      const output = JSON.parse(result.stdout.toString()) as {
        readOnly: string[]
        commandOptions: Record<string, string[]>
      }
      expect(output.readOnly).toContain('context-read')
      expect(output.readOnly).toContain('operator-receipt-lint')
      expect(output.readOnly).toContain('coordinator-preflight')
      expect(output.readOnly).not.toContain('dispatch')
      expect(Object.keys(output.commandOptions).sort()).toEqual(
        COMMANDS.map(({ name }) => name).sort()
      )
      expect(output.commandOptions.dispatch).toContain('--scope-json')
      expect(output.commandOptions.dispatch).not.toContain('--phase')
    }
  }
})

test('status reads the sidecars without writing them', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-status-'))
  const sdd = join(root, 'task.sdd.md')
  const state = `${sdd}.loop.json`
  const events = `${sdd}.events.jsonl`
  try {
    writeFileSync(sdd, '# fixture\n')
    writeFileSync(
      state,
      JSON.stringify({
        protocol: 'control-plane/state-v2',
        phase: 'DISCOVER',
        authority_epoch: 3,
        batches: [{ id: 'PC01', description: '建立入口', stage: 'verified', evidence: [] }]
      })
    )
    writeFileSync(events, '{"event":"init"}\n')
    const before = Bun.file(state).size
    const result = Bun.spawnSync([
      process.execPath,
      `${import.meta.dir}/../scripts/main.ts`,
      'status',
      '--sdd',
      sdd
    ])
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      phase: 'DISCOVER',
      eventCount: 1,
      authorityEpoch: 3,
      progress_view: { status: 'UNKNOWN', items: [] }
    })
    expect(Bun.file(state).size).toBe(before)
  } finally {
    rmSync(root, { recursive: true })
  }
})

test('progress ignores fabricated batch labels and derives pending items from the contract', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-progress-'))
  const sdd = join(root, 'task.sdd.md')
  try {
    writeFileSync(sdd, admissionFixture().source)
    initLoop(sdd, 4)
    const path = sdd + '.loop.json',
      state = JSON.parse(readFileSync(path, 'utf8'))
    state.batches = [{ id: 'PC99', stage: 'verified', evidence: ['EVT-fake'] }]
    writeFileSync(path, JSON.stringify(state))
    const before = readFileSync(path, 'utf8')
    const result = Bun.spawnSync([
      process.execPath,
      import.meta.dir + '/../scripts/main.ts',
      'status',
      '--sdd',
      sdd
    ])
    expect(result.exitCode).toBe(0)
    const progress = JSON.parse(result.stdout.toString()).progress_view
    expect(progress.items).toHaveLength(1)
    expect(progress.items[0]).toMatchObject({
      id: 'XQ01',
      description: 'Return two',
      stage: 'PENDING',
      evidence_ids: []
    })
    expect(readFileSync(path, 'utf8')).toBe(before)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('document-check catches missing descriptions, invalid IDs and dangling references', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-document-'))
  const sdd = join(root, 'task.sdd.md')
  try {
    writeFileSync(
      sdd,
      [
        '# Fixture',
        '',
        '| id | name | |',
        '| --- | --- | --- |',
        '| PC1 | item | |',
        '',
        '- PC02 item',
        '- see PC03',
        '```',
        '| no | table |',
        '```',
        ''
      ].join('\n')
    )
    const result = Bun.spawnSync([
      process.execPath,
      `${import.meta.dir}/../scripts/main.ts`,
      'document-check',
      '--sdd',
      sdd
    ])
    expect(result.exitCode).toBe(1)
    const output = JSON.parse(result.stdout.toString()) as {
      valid: boolean
      diagnostics: Array<{ code: string }>
    }
    expect(output.valid).toBe(false)
    expect(output.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(['SDD_TABLE_DESCRIPTION_MISSING', 'SDD_ID_INVALID', 'SDD_ID_DANGLING'])
    )
  } finally {
    rmSync(root, { recursive: true })
  }
})

test('validate requires complete design sections and keeps structural scope explicit', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-validate-'))
  const sdd = join(root, 'task.sdd.md')
  try {
    writeFileSync(
      sdd,
      [
        '# Fixture',
        '## Breaking Changes\nNo breaking changes; compatibility is preserved.',
        '## New/Changed API & Typing\nNo public API changes.',
        '## New/Changed Entities & Tools\nNo new entities.',
        '## Implementation Flow & Pseudocode\nRead input, validate it, and return the result.',
        '## Delivery & Verification\nRun the focused verification and record its result.',
        '',
        '<!-- sdd-contract:start -->',
        '```json',
        JSON.stringify({
          protocol: 'sdd-loop-delivery/v1',
          revision: 'v1',
          requirements: [{ id: 'XQ01', title: 'Deliver feature', kind: 'must-ship' }]
        }),
        '```',
        '<!-- sdd-contract:end -->',
        ''
      ].join('\n')
    )
    const result = Bun.spawnSync([
      process.execPath,
      `${import.meta.dir}/../scripts/main.ts`,
      'validate',
      '--sdd',
      sdd
    ])
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      valid: true,
      requiredSections: expect.arrayContaining(['Breaking Changes'])
    })
  } finally {
    rmSync(root, { recursive: true })
  }
})

test('validate-draft is read-only and reports draft provenance', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-draft-'))
  const sdd = join(root, 'draft.sdd.md')
  try {
    writeFileSync(
      sdd,
      [
        '# Draft',
        '## Breaking Changes\nNo breaking changes; compatibility is preserved.',
        '## New/Changed API & Typing\nNo public API changes.',
        '## New/Changed Entities & Tools\nNo new entities.',
        '## Implementation Flow & Pseudocode\nRead input, validate it, and return the result.',
        '## Delivery & Verification\nRun the focused verification and record its result.',
        '<!-- sdd-contract:start -->',
        '```json',
        JSON.stringify({
          protocol: 'sdd-loop-delivery/v1',
          revision: 'v1',
          requirements: [{ id: 'XQ01', title: 'Deliver feature', kind: 'must-ship' }]
        }),
        '```',
        '<!-- sdd-contract:end -->'
      ].join('\n')
    )
    const result = Bun.spawnSync([
      process.execPath,
      `${import.meta.dir}/../scripts/main.ts`,
      'validate-draft',
      '--sdd',
      sdd
    ])
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      valid: true,
      draft: true,
      persisted: false
    })
    expect(readdirSync(root)).toEqual(['draft.sdd.md'])
  } finally {
    rmSync(root, { recursive: true })
  }
})

test('validate-draft accepts an unpersisted draft file without creating sidecars', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-draft-input-'))
  const draft = join(root, 'candidate.sdd.md')
  const source = [
    '# Candidate',
    '## Breaking Changes',
    'None; existing behavior remains.',
    '## New/Changed API & Typing',
    'No API changes; existing signature remains.',
    '## New/Changed Entities & Tools',
    'No new entities; reuse current module.',
    '## Implementation Flow & Pseudocode',
    '1. Read input and return the validated result.',
    '## Delivery & Verification',
    'Run the focused acceptance check.',
    '<!-- sdd-contract:start -->',
    '```json',
    JSON.stringify({
      protocol: 'sdd-loop-delivery/v1',
      revision: 'v1',
      requirements: [{ id: 'XQ01', title: 'Deliver feature', kind: 'must-ship' }]
    }),
    '```',
    '<!-- sdd-contract:end -->'
  ].join('\n')
  try {
    writeFileSync(draft, source)
    const result = Bun.spawnSync([
      process.execPath,
      `${import.meta.dir}/../scripts/main.ts`,
      'validate-draft',
      '--draft-file',
      draft
    ])
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      sdd: draft,
      valid: true,
      draft: true,
      persisted: false
    })
    expect(existsSync(`${draft}.loop.json`)).toBe(false)
    expect(existsSync(`${draft}.events.jsonl`)).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('validate-draft reads stdin when no path is supplied and keeps invalid drafts fail-closed', () => {
  const result = Bun.spawnSync(
    [process.execPath, `${import.meta.dir}/../scripts/main.ts`, 'validate-draft'],
    { stdin: new Blob(['## Implementation Flow & Pseudocode\nTODO']) }
  )
  expect(result.exitCode).toBe(1)
  expect(JSON.parse(result.stdout.toString())).toMatchObject({ draft: true, persisted: false })
  expect(result.stdout.toString()).toContain('SDD_REQUIRED_SECTION_MISSING')
})

test('validate rejects empty required sections and implementation placeholders', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-invalid-draft-'))
  const sdd = join(root, 'draft.sdd.md')
  try {
    writeFileSync(
      sdd,
      [
        '# Draft',
        '## Breaking Changes',
        '## New/Changed API & Typing\nNo public API changes.',
        '## New/Changed Entities & Tools\nNo new entities.',
        '## Implementation Flow & Pseudocode\nTODO',
        '## Delivery & Verification\nRun checks.'
      ].join('\n')
    )
    const result = Bun.spawnSync([
      process.execPath,
      `${import.meta.dir}/../scripts/main.ts`,
      'validate',
      '--sdd',
      sdd
    ])
    expect(result.exitCode).toBe(1)
    expect(
      JSON.parse(result.stdout.toString()).diagnostics.map((item: { code: string }) => item.code)
    ).toEqual(
      expect.arrayContaining(['SDD_REQUIRED_SECTION_EMPTY', 'SDD_IMPLEMENTATION_PLACEHOLDER'])
    )
  } finally {
    rmSync(root, { recursive: true })
  }
})

test('document-next-id suggests a stable prefix sequence without writing', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-next-id-'))
  const sdd = join(root, 'task.sdd.md')
  try {
    writeFileSync(sdd, '# Task\nPC01 first\nPC09 last\n')
    const result = Bun.spawnSync([
      process.execPath,
      `${import.meta.dir}/../scripts/main.ts`,
      'document-next-id',
      '--sdd',
      sdd,
      '--prefix',
      'PC'
    ])
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout.toString())).toEqual({ prefix: 'PC', next: 'PC10' })
    expect(readdirSync(root)).toEqual(['task.sdd.md'])
  } finally {
    rmSync(root, { recursive: true })
  }
})

test('worktree-view reports actual dirty paths without writing', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-worktree-'))
  try {
    Bun.spawnSync(['git', 'init', '-q', root])
    writeFileSync(join(root, 'tracked.txt'), 'base\n')
    Bun.spawnSync(['git', '-C', root, 'add', 'tracked.txt'])
    Bun.spawnSync([
      'git',
      '-C',
      root,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-qm',
      'base'
    ])
    writeFileSync(join(root, 'tracked.txt'), 'changed\n')
    writeFileSync(join(root, 'new.txt'), 'new\n')
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root-package' }))
    mkdirSync(join(root, 'packages', 'web-rpc'), { recursive: true })
    writeFileSync(
      join(root, 'packages', 'web-rpc', 'package.json'),
      JSON.stringify({ name: '@migaia/web-rpc' })
    )
    mkdirSync(join(root, 'services', 'api'), { recursive: true })
    writeFileSync(join(root, 'services', 'api', 'go.mod'), 'module example.com/api\n')
    mkdirSync(join(root, 'crates', 'core'), { recursive: true })
    writeFileSync(
      join(root, 'crates', 'core', 'Cargo.toml'),
      '[package]\nname = "core"\nversion = "1.0.0"\n'
    )
    const result = Bun.spawnSync([
      process.execPath,
      `${import.meta.dir}/../scripts/main.ts`,
      'worktree-view',
      '--workspace',
      root
    ])
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      protocol: 'worktree-view/v1',
      changes: expect.arrayContaining([' M tracked.txt', '?? new.txt']),
      owners: expect.arrayContaining([
        { root: 'packages/web-rpc', identity: '@migaia/web-rpc', manifest: 'package.json' }
      ])
    })
    const owners = JSON.parse(result.stdout.toString()).owners as { identity: string }[]
    expect(owners.map(({ identity }) => identity)).toEqual(
      expect.arrayContaining(['@migaia/web-rpc', 'example.com/api', 'core'])
    )
  } finally {
    rmSync(root, { recursive: true })
  }
})

test('worktree owner discovery does not follow symlinked directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-symlink-'))
  const outside = mkdtempSync(join(tmpdir(), 'sdd-loop-outside-'))
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root-package' }))
    writeFileSync(join(outside, 'package.json'), JSON.stringify({ name: 'outside-package' }))
    symlinkSync(outside, join(root, 'linked'), 'dir')
    const git = Bun.spawnSync(['git', 'init', '--quiet'], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe'
    })
    expect(git.exitCode).toBe(0)
    const snapshot = snapshotWorktree(root)
    expect(snapshot.owners.map(({ identity }) => identity)).toEqual(['root-package'])
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('worktree owner discovery supports Go and Rust manifests alongside npm packages', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-manifests-'))
  try {
    mkdirSync(join(root, 'go'))
    mkdirSync(join(root, 'rust'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@scope/root' }))
    writeFileSync(join(root, 'go', 'go.mod'), 'module example.com/service\n\ngo 1.22\n')
    writeFileSync(join(root, 'rust', 'Cargo.toml'), '[package]\nname = "rust-service"\n')
    const git = Bun.spawnSync(['git', 'init', '--quiet'], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe'
    })
    expect(git.exitCode).toBe(0)
    const snapshot = snapshotWorktree(root)
    expect(snapshot.owners).toEqual(
      expect.arrayContaining([
        { root: '.', identity: '@scope/root', manifest: 'package.json' },
        { root: 'go', identity: 'example.com/service', manifest: 'go.mod' },
        { root: 'rust', identity: 'rust-service', manifest: 'Cargo.toml' }
      ])
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('worktree status preserves paths containing spaces and Unicode', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-paths-'))
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root-package' }))
    const git = Bun.spawnSync(['git', 'init', '--quiet'], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe'
    })
    expect(git.exitCode).toBe(0)
    const path = join(root, '空 格.ts')
    writeFileSync(path, 'export {}\n')
    const snapshot = snapshotWorktree(root)
    expect(snapshot.changes.some((change) => change.includes('空 格.ts'))).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('operator-receipt-lint requires a complete manifest and preserves rejected receipts', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-receipt-'))
  const receipt = join(root, 'receipt.json')
  try {
    writeFileSync(
      receipt,
      JSON.stringify({ role: 'Operator', agent_id: 'a', lease_id: 'l', status: 'partial' })
    )
    const result = Bun.spawnSync([
      process.execPath,
      `${import.meta.dir}/../scripts/main.ts`,
      'operator-receipt-lint',
      '--receipt',
      receipt
    ])
    expect(result.exitCode).toBe(1)
    expect(
      JSON.parse(result.stdout.toString()).diagnostics.map((item: { code: string }) => item.code)
    ).toContain('RECEIPT_MANIFEST_REQUIRED')
    writeFileSync(
      receipt,
      JSON.stringify({
        role: 'Operator',
        agent_id: 'a',
        lease_id: 'l',
        status: 'candidate',
        changes: [{ path: 'src/index.ts', action: 'MODIFIED' }]
      })
    )
    const valid = Bun.spawnSync([
      process.execPath,
      `${import.meta.dir}/../scripts/main.ts`,
      'operator-receipt-lint',
      '--receipt',
      receipt
    ])
    expect(valid.exitCode).toBe(0)
  } finally {
    rmSync(root, { recursive: true })
  }
})

test('operator receipt lint requires both endpoints for a rename', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-rename-'))
  const receipt = join(root, 'receipt.json')
  try {
    writeFileSync(
      receipt,
      JSON.stringify({
        role: 'Operator',
        agent_id: 'agent-1',
        lease_id: 'lease-1',
        status: 'partial',
        changes: [{ path: 'new.ts', action: 'RENAMED', from_path: 'old.ts' }]
      })
    )
    const result = lintOperatorReceipt(receipt)
    expect(result.valid).toBe(false)
    expect(result.diagnostics.map(({ code }) => code)).toContain('RECEIPT_RENAME_TARGET_REQUIRED')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('operator receipt lint rejects absolute and traversal manifest paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-unsafe-receipt-'))
  const receipt = join(root, 'receipt.json')
  try {
    writeFileSync(
      receipt,
      JSON.stringify({
        role: 'Operator',
        agent_id: 'agent-1',
        lease_id: 'lease-1',
        status: 'partial',
        changes: [
          { path: '../outside.ts', action: 'MODIFIED' },
          { path: '..\\\\outside-win.ts', action: 'MODIFIED' },
          { path: 'C:\\\\outside-drive.ts', action: 'MODIFIED' },
          { path: '/tmp/x', action: 'MODIFIED' }
        ]
      })
    )
    const result = lintOperatorReceipt(receipt)
    expect(result.valid).toBe(false)
    expect(result.diagnostics.map(({ code }) => code)).toContain('RECEIPT_CHANGE_PATH_UNSAFE')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('finding policy keeps evidence identity and requires re-verification before resolution', () => {
  const finding = {
    id: 'FX01',
    status: 'open' as const,
    priority: 'P1' as const,
    evidenceId: 'ev-1',
    candidateId: 'candidate-1',
    affectedRequirements: ['XQ01'],
    reverifyRequired: true
  }
  expect(() => assertFinding(finding)).not.toThrow()
  expect(() => assertFinding({ ...finding, status: 'resolved' })).toThrow(
    'FINDING_REVERIFY_REQUIRED'
  )
  expect(resolveFinding(finding, 'ev-2')).toMatchObject({
    id: 'FX01',
    status: 'resolved',
    evidenceId: 'ev-1',
    reverifyRequired: false
  })
  expect(() => resolveFinding(finding, '')).toThrow('FINDING_REVERIFY_EVIDENCE_REQUIRED')
})

test('bootstrap policy requires ordered successful receipts from one agent and distinct processes', () => {
  const receipts = [
    { stage: 'OPEN' as const, agentId: 'agent-1', processId: 'p1', success: true },
    { stage: 'REAUTHENTICATE' as const, agentId: 'agent-1', processId: 'p2', success: true },
    { stage: 'READY' as const, agentId: 'agent-1', processId: 'p3', success: true }
  ]
  expect(() => assertBootstrapReceipts(receipts)).not.toThrow()
  expect(() => assertBootstrapReceipts(receipts.slice(1))).toThrow('BOOTSTRAP_STAGES_REQUIRED')
  expect(() =>
    assertBootstrapReceipts([{ ...receipts[0]!, stage: 'READY' }, receipts[1]!, receipts[2]!])
  ).toThrow('BOOTSTRAP_STAGE_ORDER_INVALID')
  expect(() =>
    assertBootstrapReceipts([{ ...receipts[0]!, processId: 'p2' }, receipts[1]!, receipts[2]!])
  ).toThrow('BOOTSTRAP_PROCESS_NOT_DISTINCT')
})

test('bootstrap preflight validates a receipt file without persisting state', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-bootstrap-preflight-'))
  const payload = join(root, 'receipts.json')
  try {
    writeFileSync(
      payload,
      JSON.stringify([
        { stage: 'OPEN', agentId: 'agent-1', processId: 'p1', success: true },
        { stage: 'REAUTHENTICATE', agentId: 'agent-1', processId: 'p2', success: true },
        { stage: 'READY', agentId: 'agent-1', processId: 'p3', success: true }
      ])
    )
    expect(validateBootstrapPayload(payload)).toEqual({
      protocol: 'agent-bootstrap-preflight/v1',
      agentId: 'agent-1',
      stages: [
        { stage: 'OPEN', processId: 'p1' },
        { stage: 'REAUTHENTICATE', processId: 'p2' },
        { stage: 'READY', processId: 'p3' }
      ],
      persisted: false
    })
    expect(readdirSync(root).sort()).toEqual(['receipts.json'])
  } finally {
    rmSync(root, { recursive: true })
  }
})

test('agent-bootstrap CLI exposes only the explicit read-only preflight path', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-bootstrap-cli-'))
  const payload = join(root, 'receipts.json')
  try {
    writeFileSync(
      payload,
      JSON.stringify([
        { stage: 'OPEN', agentId: 'agent-1', processId: 'p1', success: true },
        { stage: 'REAUTHENTICATE', agentId: 'agent-1', processId: 'p2', success: true },
        { stage: 'READY', agentId: 'agent-1', processId: 'p3', success: true }
      ])
    )
    const result = Bun.spawnSync([
      process.execPath,
      `${import.meta.dir}/../scripts/main.ts`,
      'agent-bootstrap',
      '--agent-id',
      'agent-1',
      '--receipts-file',
      payload
    ])
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      protocol: 'agent-bootstrap-preflight/v1',
      persisted: false
    })
  } finally {
    rmSync(root, { recursive: true })
  }
})

test('agent-bootstrap preflight rejects duplicate process receipts', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-bootstrap-duplicate-'))
  const payload = join(root, 'receipts.json')
  try {
    writeFileSync(
      payload,
      JSON.stringify([
        { stage: 'OPEN', agentId: 'agent-1', processId: 'p1', success: true },
        { stage: 'REAUTHENTICATE', agentId: 'agent-1', processId: 'p1', success: true },
        { stage: 'READY', agentId: 'agent-1', processId: 'p3', success: true }
      ])
    )
    expect(() => validateBootstrapPayload(payload)).toThrow('BOOTSTRAP_PROCESS_NOT_DISTINCT')
  } finally {
    rmSync(root, { recursive: true })
  }
})

test('agent-bootstrap without assignment arguments remains fail-closed', () => {
  const result = Bun.spawnSync([
    process.execPath,
    `${import.meta.dir}/../scripts/main.ts`,
    'agent-bootstrap',
    '--sdd',
    'missing.sdd',
    '--agent-id',
    'agent-1'
  ])
  expect(result.exitCode).toBe(2)
  expect(result.stderr.toString()).toContain('BOOTSTRAP_ARGS_REQUIRED')
})

test('state decoding retains native fields without mutating the source', () => {
  const original = {
    protocol: 'control-plane/state-v2',
    phase: 'VERIFY',
    authority_epoch: 4,
    active_lease: { id: 'lease-1' },
    extra: 'kept'
  }
  const decoded = decodeState(original)
  expect(decoded).toEqual(original)
  expect(decoded).not.toBe(original)
  expect(original).not.toHaveProperty('authorityEpoch')
})

test('state snapshots retain a consistent state and event pair', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-snapshot-'))
  const sdd = join(root, 'task.sdd.md')
  try {
    writeFileSync(sdd, '# fixture\n')
    writeFileSync(
      `${sdd}.loop.json`,
      JSON.stringify({ protocol: 'control-plane/state-v2', phase: 'DISCOVER' })
    )
    writeFileSync(`${sdd}.events.jsonl`, '{"event":"init"}\n')
    const snapshot = readSnapshot(sdd)
    expect(snapshot.eventCount).toBe(1)
    expect(snapshot.state.phase).toBe('DISCOVER')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('event log checking requires one JSON object per line', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-events-'))
  const log = join(root, 'events.jsonl')
  try {
    writeFileSync(log, '{"event":"one"}\n{"event":"two"}\n')
    expect(checkEventLog(log)).toEqual({ valid: true, eventCount: 2 })
    writeFileSync(log, '{"event":"one"}\n[1]\n')
    expect(checkEventLog(log)).toMatchObject({ valid: false, error: 'EVENT_RECORD_INVALID' })
    writeFileSync(log, '{"event":\n')
    expect(checkEventLog(log)).toMatchObject({ valid: false, error: 'EVENT_JSON_INVALID' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('operator-receipt-scaffold emits a bound, non-persisted template', () => {
  const result = Bun.spawnSync([
    process.execPath,
    `${import.meta.dir}/../scripts/main.ts`,
    'operator-receipt-scaffold',
    '--agent-id',
    'agent-1',
    '--lease-id',
    'lease-1'
  ])
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout.toString())).toMatchObject({
    protocol: 'operator-receipt/v1',
    role: 'Operator',
    agent_id: 'agent-1',
    lease_id: 'lease-1',
    status: 'partial'
  })
})

test('path shape cannot substitute for a lease and frozen scope rejects traversal', () => {
  const result = Bun.spawnSync([
    process.execPath,
    import.meta.dir + '/../scripts/main.ts',
    'pre-action',
    '--workspace',
    '/repo',
    '--path',
    'src/index.ts'
  ])
  expect(result.exitCode).not.toBe(0)
  expect(() => assertPathInScope('src/index.ts', ['src'], [])).not.toThrow()
  expect(() => assertPathInScope('../secrets', ['.'], [])).toThrow()
  expect(() => assertPathInScope('/tmp/file', ['.'], [])).toThrow()
  expect(() => assertPathInScope('other/index.ts', ['src'], [])).toThrow('LEASE_SCOPE_DENIED')
  const mapping = [{ root: 'packages/app', identity: '@example/app' }]
  expect(() => assertPathInScope('packages/app/index.ts', ['@example/app'], mapping)).not.toThrow()
  expect(() => assertPathInScope('packages/other/index.ts', ['@example/app'], mapping)).toThrow()
})

test('coordinator-preflight validates submitted fields without asserting host provenance', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-host-'))
  const receipt = join(root, 'host.json')
  try {
    writeFileSync(receipt, JSON.stringify({ task_path: '/root/coordinator' }))
    const rejected = Bun.spawnSync([
      process.execPath,
      `${import.meta.dir}/../scripts/main.ts`,
      'coordinator-preflight',
      '--runtime-receipt',
      receipt
    ])
    expect(rejected.exitCode).toBe(1)
    expect(rejected.stderr.toString()).toContain('HOST_RECEIPT_INVALID')
    writeFileSync(
      receipt,
      JSON.stringify({
        protocol: 'host-spawn-receipt/v1',
        agent_id: 'agent-1',
        runtime: 'codex',
        model: 'gpt-6-astra',
        isolation: 'isolated'
      })
    )
    const accepted = Bun.spawnSync([
      process.execPath,
      `${import.meta.dir}/../scripts/main.ts`,
      'coordinator-preflight',
      '--runtime-receipt',
      receipt
    ])
    expect(accepted.exitCode).toBe(0)
    expect(JSON.parse(accepted.stdout.toString())).toMatchObject({
      schemaValid: true,
      verified: false,
      hostIdentityVerified: false,
      verificationScope: 'submitted-fields-only',
      agent_id: 'agent-1',
      model: 'gpt-6-astra'
    })
  } finally {
    rmSync(root, { recursive: true })
  }
})

test('init creates the sidecars once and repeated init is idempotent', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-init-'))
  const sdd = join(root, 'task.sdd.md')
  try {
    writeFileSync(sdd, '# Contract\n')
    const first = Bun.spawnSync([
      process.execPath,
      `${import.meta.dir}/../scripts/main.ts`,
      'init',
      '--sdd',
      sdd,
      '--max-rounds',
      '3'
    ])
    expect(first.exitCode).toBe(0)
    expect(JSON.parse(first.stdout.toString())).toMatchObject({
      protocol: 'control-plane/state-v2',
      phase: 'DISCOVER',
      max_rounds: 3
    })
    const stateBytes = readFileSync(`${sdd}.loop.json`, 'utf8')
    expect(readFileSync(`${sdd}.events.jsonl`, 'utf8')).toContain('"role":"coordinator"')
    const second = Bun.spawnSync([
      process.execPath,
      `${import.meta.dir}/../scripts/main.ts`,
      'init',
      '--sdd',
      sdd,
      '--max-rounds',
      '9'
    ])
    expect(second.exitCode).toBe(0)
    expect(JSON.parse(second.stdout.toString()).max_rounds).toBe(3)
    expect(readFileSync(`${sdd}.loop.json`, 'utf8')).toBe(stateBytes)
  } finally {
    rmSync(root, { recursive: true })
  }
})

test('init rejects an orphan event log instead of overwriting history', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-init-orphan-'))
  const sdd = join(root, 'task.sdd.md')
  try {
    writeFileSync(sdd, '# Contract\n')
    writeFileSync(`${sdd}.events.jsonl`, '{"event":"old"}\n')
    const result = Bun.spawnSync([
      process.execPath,
      `${import.meta.dir}/../scripts/main.ts`,
      'init',
      '--sdd',
      sdd
    ])
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('INIT_EVENT_LOG_WITHOUT_STATE_INVALID')
    expect(existsSync(`${sdd}.loop.json`)).toBe(false)
  } finally {
    rmSync(root, { recursive: true })
  }
})

test('init rejects invalid round limits before creating any sidecar', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-init-rounds-'))
  const sdd = join(root, 'task.sdd.md')
  try {
    writeFileSync(sdd, '# Contract\n')
    const result = Bun.spawnSync([
      process.execPath,
      `${import.meta.dir}/../scripts/main.ts`,
      'init',
      '--sdd',
      sdd,
      '--max-rounds',
      '21'
    ])
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('MAX_ROUNDS_INVALID')
    expect(readdirSync(root)).toEqual(['task.sdd.md'])
  } finally {
    rmSync(root, { recursive: true })
  }
})

test('transition authenticates the Coordinator and journals a valid phase change', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-transition-'))
  const sdd = join(root, 'task.sdd.md')
  const token = 'coordinator-test-token'
  try {
    writeFileSync(sdd, '# fixture\n')
    writeFileSync(
      `${sdd}.loop.json`,
      JSON.stringify({
        protocol: 'control-plane/state-v2',
        phase: 'DISCOVER',
        revision: 4,
        contract_revision: 'v1',
        sdd_fingerprint: createHash('sha256').update(readFileSync(sdd)).digest('hex'),
        authority_epoch: 2,
        coordinator_token_hash: createHash('sha256').update(token).digest('hex'),
        active_lease: null
      })
    )
    expect(transition(sdd, 'coordinator', 'DISCOVER', 'v1', 'ARCHITECT', token)).toMatchObject({
      protocol: 'transition/v1',
      from: 'DISCOVER',
      to: 'ARCHITECT'
    })
    expect(JSON.parse(readFileSync(`${sdd}.loop.json`, 'utf8'))).toMatchObject({
      phase: 'ARCHITECT',
      revision: 5
    })
    expect(readFileSync(`${sdd}.events.jsonl`, 'utf8')).toContain('state_transition')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('attempt records bounded Coordinator progress and preserves lease safety', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-attempt-'))
  const sdd = join(root, 'task.sdd.md')
  const token = 'coordinator-test-token'
  try {
    writeFileSync(sdd, '# fixture\n')
    writeFileSync(
      `${sdd}.loop.json`,
      JSON.stringify({
        protocol: 'control-plane/state-v2',
        phase: 'COORDINATOR_TRIAGE',
        revision: 4,
        contract_revision: 'v1',
        max_rounds: 6,
        round_completed_attempts: 0,
        completed_attempts: 2,
        consecutive_stagnant_attempts: 0,
        authority_epoch: 1,
        active_lease: null,
        coordinator_token_hash: createHash('sha256').update(token).digest('hex')
      })
    )
    expect(
      attempt(sdd, 'coordinator', 'COORDINATOR_TRIAGE', 'v1', 'progress', token)
    ).toMatchObject({
      protocol: 'attempt/v1',
      attempt: 1
    })
    expect(JSON.parse(readFileSync(`${sdd}.loop.json`, 'utf8'))).toMatchObject({
      round_completed_attempts: 1,
      completed_attempts: 3,
      revision: 5
    })
    const after = JSON.parse(readFileSync(sdd + '.loop.json', 'utf8'))
    const roleToken = 'reviewer-test'
    after.consecutive_architect_rejections = 2
    after.last_role_events = { verification: 'review-result' }
    after.issued_leases = {
      review: {
        lease_id: 'review',
        role: 'architect',
        agent_id: 'reviewer',
        authority_epoch: 1,
        contract_revision: 'v1',
        event_public_key: rolePublicKey(roleToken)
      }
    }
    writeFileSync(sdd + '.loop.json', JSON.stringify(after))
    const priorEvents = readFileSync(sdd + '.events.jsonl', 'utf8')
    const valid = signRoleEvent(
      {
        event_id: 'review-result',
        role: 'architect',
        type: 'verification',
        contract_revision: 'v1',
        state: 'ARCHITECT_VERIFY',
        actor: { lease_id: 'review', agent_id: 'reviewer', authority_epoch: 1 },
        payload: { result: 'PASS' }
      },
      roleToken
    )
    const forged = JSON.stringify({ ...valid, signature: 'forged' }) + '\n'
    // Fixture history is rebound so this case exercises provenance, not log integrity.
    const rebind = (events: string) => {
      writeFileSync(sdd + '.events.jsonl', events)
      writeFileSync(
        sdd + '.loop.json',
        bindEventLog(Buffer.from(JSON.stringify(after)), eventLogBinding(Buffer.from(events)))
      )
    }
    rebind(priorEvents + forged)
    const before = readFileSync(sdd + '.loop.json')
    expect(() =>
      attempt(sdd, 'coordinator', 'COORDINATOR_TRIAGE', 'v1', 'progress', token)
    ).toThrow('ROLE_EVIDENCE_PROVENANCE_INVALID')
    expect(readFileSync(sdd + '.loop.json')).toEqual(before)
    expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe(priorEvents + forged)
    rebind(priorEvents + JSON.stringify(valid) + '\n')
    expect(attempt(sdd, 'coordinator', 'COORDINATOR_TRIAGE', 'v1', 'progress', token).attempt).toBe(
      2
    )
    expect(readSnapshot(sdd).state.consecutive_architect_rejections).toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runtime-record binds host facts and is idempotent by observation id', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-runtime-record-'))
  const sdd = join(root, 'task.sdd.md')
  const token = 'coordinator-test-token'
  const payload = {
    id: 'OBS01',
    agent_id: 'operator-1',
    previous_record_id: null,
    action: 'observe',
    host: {
      model: 'gpt-5.6-terra',
      reasoning_effort: 'medium',
      status: 'idle',
      controllable: true,
      writer_stopped: true,
      commands_stopped: true,
      close_available: false,
      conversation_id: 'isolated',
      ancestor_ids: ['supervisor'],
      confirmed_by: 'supervisor'
    },
    evidence: 'host receipt',
    agent_role: 'operator',
    controller: sdd,
    authority_epoch: 1
  }
  try {
    writeFileSync(sdd, '# fixture\n')
    writeFileSync(
      `${sdd}.loop.json`,
      JSON.stringify({
        protocol: 'control-plane/state-v2',
        phase: 'ARCHITECT_VERIFY',
        revision: 1,
        contract_revision: 'v1',
        coordinator_event_keys: { '1': rolePublicKey(token) },
        authority_epoch: 1,
        coordinator_token_hash: createHash('sha256').update(token).digest('hex')
      })
    )
    const first = runtimeRecord(sdd, 'coordinator', 'ARCHITECT_VERIFY', 'v1', payload, token)
    const second = runtimeRecord(sdd, 'coordinator', 'ARCHITECT_VERIFY', 'v1', payload, token)
    expect(second.eventId).toBe(first.eventId)
    expect(JSON.parse(readFileSync(`${sdd}.loop.json`, 'utf8'))).toMatchObject({ revision: 2 })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('failure controllers separate product failures from pipeline incidents', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-failure-'))
  const sdd = join(root, 'task.sdd.md')
  const token = 'coordinator-test-token'
  try {
    writeFileSync(sdd, '# fixture\n')
    writeFileSync(
      `${sdd}.loop.json`,
      JSON.stringify({
        protocol: 'control-plane/state-v2',
        phase: 'ARCHITECT_VERIFY',
        revision: 1,
        contract_revision: 'v1',
        authority_epoch: 1,
        active_lease: null,
        coordinator_token_hash: createHash('sha256').update(token).digest('hex')
      })
    )
    expect(
      failure(
        'pipeline',
        sdd,
        'coordinator',
        'ARCHITECT_VERIFY',
        'v1',
        'operator',
        'host unavailable',
        'HOST_LIMIT',
        token
      )
    ).toMatchObject({ protocol: 'failure/v1', kind: 'pipeline' })
    expect(JSON.parse(readFileSync(`${sdd}.loop.json`, 'utf8'))).toMatchObject({
      pipeline_incidents: 1,
      pending_pipeline_repair: { root_cause_key: 'HOST_LIMIT' }
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('transaction-recover requires stop evidence and is idempotent with no journal', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-recover-cli-'))
  const sdd = join(root, 'task.sdd.md')
  const token = 'coordinator-test-token'
  try {
    writeFileSync(sdd, '# fixture\n')
    writeFileSync(
      `${sdd}.loop.json`,
      JSON.stringify({
        protocol: 'control-plane/state-v2',
        phase: 'IMPLEMENTING',
        revision: 1,
        contract_revision: 'v1',
        coordinator_token_hash: createHash('sha256').update(token).digest('hex'),
        active_lease: null
      })
    )
    expect(() => transactionRecover(sdd, 'coordinator', 'IMPLEMENTING', 'v1', 'no', token)).toThrow(
      'PREVIOUS_WRITERS_STOP_CONFIRMATION_REQUIRED'
    )
    expect(transactionRecover(sdd, 'coordinator', 'IMPLEMENTING', 'v1', 'yes', token)).toEqual({
      protocol: 'transaction-recover/v1',
      status: 'nothing-pending'
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('lock-recover removes only a matching orphan lock', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-lock-recover-'))
  const sdd = join(root, 'task.sdd.md')
  const token = 'coordinator-test-token'
  try {
    writeFileSync(sdd, '# fixture\n')
    writeFileSync(
      `${sdd}.loop.json`,
      JSON.stringify({
        protocol: 'control-plane/state-v2',
        phase: 'IMPLEMENT',
        revision: 1,
        coordinator_token_hash: createHash('sha256').update(token).digest('hex')
      })
    )
    writeFileSync(`${sdd}.loop.lock`, 'orphan-lock')
    const hash = createHash('sha256').update('orphan-lock').digest('hex')
    expect(lockRecover(sdd, hash, 'yes', 'yes', token)).toEqual({
      protocol: 'lock-recover/v1',
      status: 'removed'
    })
    expect(existsSync(`${sdd}.loop.lock`)).toBe(false)
    expect(lockRecover(sdd, hash, 'yes', 'yes', token)).toEqual({
      protocol: 'lock-recover/v1',
      status: 'nothing-present'
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('record writes only Coordinator control events and rejects dedicated event types', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-record-'))
  const sdd = join(root, 'task.sdd.md')
  const token = 'coordinator-test-token'
  try {
    writeFileSync(sdd, admissionFixture().source)
    initLoop(sdd, 4)
    authBootstrap(sdd, 'DISCOVER', 'v1', 'yes', token)
    const previousRevision = Number(readSnapshot(sdd).state.revision)
    const result = recordEvent(
      sdd,
      'coordinator',
      'DISCOVER',
      'v1',
      'progress_note',
      { note: 'next' },
      token
    )
    expect(result).toMatchObject({ protocol: 'record/v1', type: 'progress_note' })
    expect(JSON.parse(readFileSync(`${sdd}.loop.json`, 'utf8'))).toMatchObject({
      revision: previousRevision + 1
    })
    expect(readFileSync(`${sdd}.events.jsonl`, 'utf8')).toContain('progress_note')
    expect(() =>
      recordEvent(sdd, 'coordinator', 'DISCOVER', 'v1', 'runtime_record', {}, token)
    ).toThrow('DEDICATED_EVENT_COMMAND_REQUIRED')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('user-control pause and resume preserve explicit checkpoint semantics', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-user-control-'))
  const sdd = join(root, 'task.sdd.md')
  const token = 'coordinator-test-token'
  try {
    writeFileSync(sdd, '# fixture\n')
    const lease = {
      lease_id: 'L1',
      role: 'operator',
      agent_id: 'operator-1',
      authority_epoch: 1,
      contract_revision: 'v1',
      event_public_key: rolePublicKey('operator-token')
    }
    writeFileSync(
      `${sdd}.loop.json`,
      JSON.stringify({
        protocol: 'control-plane/state-v2',
        phase: 'IMPLEMENTING',
        revision: 1,
        preparation: { prepared_id: 'P1', agent_id: 'architect' },
        contract_revision: 'v1',
        authority_epoch: 1,
        coordinator_event_keys: { '1': rolePublicKey(token) },
        coordinator_token_hash: createHash('sha256').update(token).digest('hex'),
        issued_leases: { L1: lease },
        active_lease: lease
      })
    )
    // The pause consumes a signed SAFE_TO_RESUME checkpoint from the exact active lease.
    const checkpoint = signRoleEvent(
      {
        event_id: 'CP1',
        type: 'checkpoint',
        role: 'operator',
        state: 'IMPLEMENTING',
        contract_revision: 'v1',
        actor: { agent_id: 'operator-1', lease_id: 'L1', authority_epoch: 1 },
        payload: {
          status: 'SAFE_TO_RESUME',
          completed_actions: ['edited value producer'],
          remaining_actions: ['run focused check'],
          active_commands: [],
          repository_state: {
            head: 'HEAD',
            worktree_fingerprint: `sha256:${'0'.repeat(64)}`,
            changed_paths: ['value.ts'],
            untracked_paths: []
          },
          last_check: { method: 'bun check.ts', outcome: 'NOT_RUN', evidence: 'not yet run' },
          resume: {
            next_action: 'run focused check',
            preconditions: ['worktree fingerprint unchanged'],
            stop_conditions: ['fingerprint drift']
          }
        }
      },
      'operator-token'
    )
    writeFileSync(`${sdd}.events.jsonl`, `${JSON.stringify(checkpoint)}\n`)
    expect(() =>
      userControl(
        sdd,
        'coordinator',
        'IMPLEMENTING',
        'v1',
        'pause',
        'hold',
        'yes',
        'yes',
        undefined,
        token
      )
    ).toThrow('USER_CONTROL_SAFE_CHECKPOINT_REQUIRED')
    expect(
      userControl(
        sdd,
        'coordinator',
        'IMPLEMENTING',
        'v1',
        'pause',
        'hold',
        'yes',
        'yes',
        'CP1',
        token
      )
    ).toMatchObject({ action: 'pause', state: 'PAUSED' })
    expect(JSON.parse(readFileSync(`${sdd}.loop.json`, 'utf8'))).toMatchObject({
      phase: 'PAUSED',
      revision: 2,
      active_lease: null,
      preparation: null
    })
    expect(
      userControl(
        sdd,
        'coordinator',
        'PAUSED',
        'v1',
        'resume',
        'continue',
        'yes',
        undefined,
        undefined,
        token
      )
    ).toMatchObject({ action: 'resume', state: 'IMPLEMENTING' })
    expect(JSON.parse(readFileSync(`${sdd}.loop.json`, 'utf8'))).toMatchObject({
      phase: 'IMPLEMENTING',
      revision: 3,
      active_lease: null,
      preparation: null
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('requirement update enforces evidence and Must-Ship deferral metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-requirement-'))
  const sdd = join(root, 'task.sdd.md')
  const token = 'coordinator-test-token'
  try {
    const fixture = admissionFixture(),
      revised = structuredClone(fixture.contract)
    Object.assign(revised.requirements[0]!, {
      deferred: { owner: 'owner', trigger: 'trigger', impact: 'impact', approved_by: 'user' }
    })
    writeFileSync(
      sdd,
      fixture.source.replace(JSON.stringify(fixture.contract), JSON.stringify(revised))
    )
    initLoop(sdd, 4)
    authBootstrap(sdd, 'DISCOVER', 'v1', 'yes', token)
    expect(() =>
      requirementUpdate(
        sdd,
        'coordinator',
        'DISCOVER',
        'v1',
        'XQ01',
        'deferred',
        undefined,
        'owner',
        'trigger',
        'impact',
        'coordinator',
        token
      )
    ).toThrow('MUST_SHIP_DEFERRAL_REQUIRES_USER')
    expect(
      requirementUpdate(
        sdd,
        'coordinator',
        'DISCOVER',
        'v1',
        'XQ01',
        'deferred',
        undefined,
        'owner',
        'trigger',
        'impact',
        'user',
        token
      )
    ).toMatchObject({ id: 'XQ01', status: 'deferred' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('finding update requires an Architect finding and preserves identity on resolution', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-finding-'))
  const sdd = join(root, 'task.sdd.md')
  const token = 'coordinator-test-token'
  const signEvidence = (body: Record<string, unknown>) =>
    signRoleEvent(
      { ...body, actor: { agent_id: 'reviewer', lease_id: 'review-lease', authority_epoch: 1 } },
      'review-token'
    )
  try {
    writeFileSync(sdd, '# fixture\n')
    writeFileSync(
      `${sdd}.loop.json`,
      JSON.stringify({
        protocol: 'control-plane/state-v2',
        phase: 'COORDINATOR_TRIAGE',
        contract_revision: 'v1',
        revision: 2,
        sdd_fingerprint: createHash('sha256').update('# fixture\n').digest('hex'),
        coordinator_token_hash: createHash('sha256').update(token).digest('hex'),
        // Seeded open Finding: opening requires an admission, covered by the chain scenarios.
        findings: { FX01: { id: 'FX01', priority: 'P1', status: 'open', evidence: 'EVT-A' } },
        issued_leases: {
          'review-lease': {
            role: 'architect',
            agent_id: 'reviewer',
            authority_epoch: 1,
            contract_revision: 'v1',
            event_public_key: rolePublicKey('review-token')
          }
        }
      })
    )
    writeFileSync(
      `${sdd}.events.jsonl`,
      JSON.stringify(
        signEvidence({
          event_id: 'EVT-A',
          role: 'architect',
          type: 'finding',
          payload: { id: 'FX01', priority: 'P1' }
        })
      ) + '\n'
    )
    expect(() =>
      findingUpdate(
        sdd,
        'coordinator',
        'COORDINATOR_TRIAGE',
        'v1',
        'FX01',
        'P1',
        'open',
        'EVT-A',
        token
      )
    ).toThrow('CONTRACT_ADMISSION_GATE_MISSING')
    expect(() =>
      findingUpdate(
        sdd,
        'coordinator',
        'COORDINATOR_TRIAGE',
        'v1',
        'FX01',
        'P1',
        'resolved',
        'EVT-A',
        token
      )
    ).toThrow('FINDING_REVERIFY_EVIDENCE_REQUIRED')
    const stateBefore = readFileSync(`${sdd}.loop.json`)
    const eventsBefore = readFileSync(`${sdd}.events.jsonl`)
    for (const missing of [undefined, '', '   ']) {
      expect(() =>
        findingUpdate(
          sdd,
          'coordinator',
          'COORDINATOR_TRIAGE',
          'v1',
          'FX01',
          'P1',
          'resolved',
          missing,
          token
        )
      ).toThrow('FINDING_REVERIFY_EVIDENCE_REQUIRED')
      expect(readFileSync(`${sdd}.loop.json`)).toEqual(stateBefore)
      expect(readFileSync(`${sdd}.events.jsonl`)).toEqual(eventsBefore)
    }
    for (const findingIds of [undefined, [], ['FX02'], ['FX01', 42]]) {
      writeFileSync(
        `${sdd}.events.jsonl`,
        eventsBefore.toString() +
          JSON.stringify(
            signEvidence({
              event_id: 'EVT-UNRELATED',
              role: 'architect',
              type: 'verification',
              payload: {
                result: 'PASS',
                ...(findingIds === undefined ? {} : { finding_ids: findingIds })
              }
            })
          ) +
          '\n'
      )
      const beforeRejected = readFileSync(`${sdd}.events.jsonl`)
      expect(() =>
        findingUpdate(
          sdd,
          'coordinator',
          'COORDINATOR_TRIAGE',
          'v1',
          'FX01',
          'P1',
          'resolved',
          'EVT-UNRELATED',
          token
        )
      ).toThrow('FINDING_REVERIFY_SCOPE_MISMATCH')
      expect(readFileSync(`${sdd}.loop.json`)).toEqual(stateBefore)
      expect(readFileSync(`${sdd}.events.jsonl`)).toEqual(beforeRejected)
    }
    writeFileSync(
      `${sdd}.events.jsonl`,
      eventsBefore.toString() +
        JSON.stringify(
          signEvidence({
            event_id: 'EVT-REVERIFY',
            role: 'architect',
            type: 'verification',
            payload: { result: 'PASS', finding_ids: ['FX01'] }
          })
        ) +
        '\n'
    )
    expect(() =>
      findingUpdate(
        sdd,
        'coordinator',
        'COORDINATOR_TRIAGE',
        'v1',
        'FX01',
        'P1',
        'resolved',
        'EVT-REVERIFY',
        token
      )
    ).toThrow('CANDIDATE_IMPLEMENTATION_REQUIRED')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('init, auth bootstrap, and dispatch form a bounded CLI chain', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-cli-chain-'))
  const sdd = join(root, 'task.sdd.md')
  const token = 'chain-token'
  try {
    writeFileSync(sdd, admissionFixture('.').source)
    expect(initLoop(sdd, 4)).toMatchObject({ revision: 1, phase: 'DISCOVER' })
    expect(authBootstrap(sdd, 'DISCOVER', 'v1', 'yes', token)).toMatchObject({
      protocol: 'auth-bootstrap/v1'
    })
    Bun.spawnSync(['git', 'init', '-q', root])
    transition(sdd, 'coordinator', 'DISCOVER', 'v1', 'ARCHITECT', token)
    transition(sdd, 'coordinator', 'ARCHITECT', 'v1', 'CONTRACT_DRAFT', token)
    recordEvent(
      sdd,
      'coordinator',
      'CONTRACT_DRAFT',
      'v1',
      'contract_admission',
      admissionFixture('.').payload,
      token
    )
    transition(sdd, 'coordinator', 'CONTRACT_DRAFT', 'v1', 'CONTRACT_ADMITTED', token)
    transition(sdd, 'coordinator', 'CONTRACT_ADMITTED', 'v1', 'OPERATOR_READBACK', token)
    expect(
      dispatch(
        sdd,
        'coordinator',
        'OPERATOR_READBACK',
        'v1',
        'operator',
        'operator-1',
        1,
        5,
        ['.'],
        'implement app',
        token,
        { worktreeRoot: root }
      )
    ).toMatchObject({ protocol: 'dispatch/v1', agentId: 'operator-1' })
    expect(JSON.parse(readFileSync(`${sdd}.loop.json`, 'utf8'))).toMatchObject({
      active_lease: { agent_id: 'operator-1' },
      revision: 8
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent bootstrap persists only the ordered host receipts for the active lease', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-bootstrap-chain-'))
  const sdd = join(root, 'task.sdd.md')
  const token = 'bootstrap-chain-token'
  const previousTokenFile = process.env.SDD_LOOP_AGENT_TOKEN_FILE
  try {
    writeFileSync(sdd, admissionFixture('.').source)
    initLoop(sdd, 4)
    authBootstrap(sdd, 'DISCOVER', 'v1', 'yes', token)
    Bun.spawnSync(['git', 'init', '-q', root])
    transition(sdd, 'coordinator', 'DISCOVER', 'v1', 'ARCHITECT', token)
    transition(sdd, 'coordinator', 'ARCHITECT', 'v1', 'CONTRACT_DRAFT', token)
    recordEvent(
      sdd,
      'coordinator',
      'CONTRACT_DRAFT',
      'v1',
      'contract_admission',
      admissionFixture('.').payload,
      token
    )
    transition(sdd, 'coordinator', 'CONTRACT_DRAFT', 'v1', 'CONTRACT_ADMITTED', token)
    transition(sdd, 'coordinator', 'CONTRACT_ADMITTED', 'v1', 'OPERATOR_READBACK', token)
    const lease = dispatch(
      sdd,
      'coordinator',
      'OPERATOR_READBACK',
      'v1',
      'operator',
      'operator-1',
      1,
      5,
      ['.'],
      'implement app',
      token,
      { worktreeRoot: root }
    )
    process.env.SDD_LOOP_AGENT_TOKEN_FILE = lease.capabilityFile
    const completed = runBootstrapProcesses(sdd, 'operator-1', 'OPERATOR_READBACK', 'v1')
    expect(completed.eventIds).toHaveLength(3)
    const before = readFileSync(sdd + '.loop.json'),
      beforeEvents = readFileSync(sdd + '.events.jsonl')
    expect(runBootstrapProcesses(sdd, 'operator-1', 'OPERATOR_READBACK', 'v1').eventIds).toEqual([])
    expect(readFileSync(sdd + '.loop.json')).toEqual(before)
    expect(readFileSync(sdd + '.events.jsonl')).toEqual(beforeEvents)
    // A credential file other than the lease-bound one never authenticates.
    const wrong = join(root, 'wrong.token')
    writeFileSync(wrong, 'wrong', { mode: 0o600 })
    process.env.SDD_LOOP_AGENT_TOKEN_FILE = wrong
    expect(() => runBootstrapProcesses(sdd, 'operator-1', 'OPERATOR_READBACK', 'v1')).toThrow()
    expect(readFileSync(sdd + '.loop.json')).toEqual(before)
    expect(readFileSync(sdd + '.events.jsonl')).toEqual(beforeEvents)
    expect(lease.leaseId).toBeTruthy()
  } finally {
    if (previousTokenFile === undefined) delete process.env.SDD_LOOP_AGENT_TOKEN_FILE
    else process.env.SDD_LOOP_AGENT_TOKEN_FILE = previousTokenFile
    rmSync(root, { recursive: true, force: true })
  }
})

test('role start and event recording require the bound role token', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-role-chain-'))
  const sdd = join(root, 'task.sdd.md')
  const previous = process.env.SDD_LOOP_AGENT_TOKEN_FILE
  const coordinator = 'role-coordinator'
  try {
    writeFileSync(sdd, admissionFixture('.').source)
    initLoop(sdd, 4)
    authBootstrap(sdd, 'DISCOVER', 'v1', 'yes', coordinator)
    Bun.spawnSync(['git', 'init', '-q', root])
    transition(sdd, 'coordinator', 'DISCOVER', 'v1', 'ARCHITECT', coordinator)
    transition(sdd, 'coordinator', 'ARCHITECT', 'v1', 'CONTRACT_DRAFT', coordinator)
    recordEvent(
      sdd,
      'coordinator',
      'CONTRACT_DRAFT',
      'v1',
      'contract_admission',
      admissionFixture('.').payload,
      coordinator
    )
    transition(sdd, 'coordinator', 'CONTRACT_DRAFT', 'v1', 'CONTRACT_ADMITTED', coordinator)
    transition(sdd, 'coordinator', 'CONTRACT_ADMITTED', 'v1', 'OPERATOR_READBACK', coordinator)
    const lease = dispatch(
      sdd,
      'coordinator',
      'OPERATOR_READBACK',
      'v1',
      'operator',
      'operator-role',
      1,
      5,
      ['.'],
      'implement app',
      coordinator,
      { worktreeRoot: root }
    )
    process.env.SDD_LOOP_AGENT_TOKEN_FILE = lease.capabilityFile
    const operatorSecret = readFileSync(lease.capabilityFile, 'utf8')
    const readResult = join(root, 'read-result.json')
    writeFileSync(
      readResult,
      JSON.stringify(contextDocumentPage(sdd, { role: 'operator' }, 0, 65536))
    )
    const baselineState = readFileSync(sdd + '.loop.json')
    const baselineEvents = readFileSync(sdd + '.events.jsonl')
    expect(() =>
      agentStartReceipt(
        sdd,
        'operator',
        'operator-role',
        lease.leaseId,
        'yes',
        'I will implement the scoped app and run its focused check before handoff.',
        'OPERATOR_READBACK',
        'v1',
        coordinator
      )
    ).toThrow('AGENT_BOOTSTRAP_REQUIRED')
    expect(readFileSync(sdd + '.loop.json')).toEqual(baselineState)
    expect(readFileSync(sdd + '.events.jsonl')).toEqual(baselineEvents)
    runBootstrapProcesses(sdd, 'operator-role', 'OPERATOR_READBACK', 'v1')
    const authenticatedEvents = readFileSync(sdd + '.events.jsonl', 'utf8')
    const forged = authenticatedEvents
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    forged[forged.length - 1].signature = 'invalid'
    const forgedBytes = forged.map((event) => JSON.stringify(event)).join('\n') + '\n'
    const authenticatedState = readFileSync(sdd + '.loop.json')
    // Rebind the forged log so the case tests bootstrap evidence, not log integrity.
    const forgedState = bindEventLog(authenticatedState, eventLogBinding(Buffer.from(forgedBytes)))
    writeFileSync(sdd + '.loop.json', forgedState)
    writeFileSync(sdd + '.events.jsonl', forgedBytes)
    expect(() =>
      agentStartReceipt(
        sdd,
        'operator',
        'operator-role',
        lease.leaseId,
        'yes',
        'I will implement the scoped app and run its focused check before handoff.',
        'OPERATOR_READBACK',
        'v1',
        coordinator
      )
    ).toThrow('AGENT_BOOTSTRAP_EVIDENCE_INVALID')
    expect(readFileSync(sdd + '.loop.json').equals(forgedState)).toBe(true)
    expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe(forgedBytes)
    writeFileSync(sdd + '.loop.json', authenticatedState)
    writeFileSync(sdd + '.events.jsonl', authenticatedEvents)
    expect(
      agentStartReceipt(
        sdd,
        'operator',
        'operator-role',
        lease.leaseId,
        readResult,
        'I will implement the scoped app and run its focused check before handoff.',
        'OPERATOR_READBACK',
        'v1',
        coordinator
      )
    ).toMatchObject({ protocol: 'agent-start-receipt/v1' })
    expect(
      agentRecord(
        sdd,
        'operator',
        'operator-role',
        lease.leaseId,
        'OPERATOR_READBACK',
        'v1',
        'contract_readback',
        {
          assessment: 'ACCEPT',
          route_assessment: 'SUPPORTED',
          independent_checks: ['fixture producer inspected'],
          unresolved_unknowns: [],
          execution_packet_ids: ['PC01'],
          semantic_ownership_review: {
            semantic_ids: ['SO01'],
            evidence: ['one fixture owner'],
            unresolved_conflicts: []
          }
        },
        operatorSecret,
        coordinator
      )
    ).toMatchObject({ protocol: 'agent-record/v1' })
  } finally {
    if (previous === undefined) delete process.env.SDD_LOOP_AGENT_TOKEN_FILE
    else process.env.SDD_LOOP_AGENT_TOKEN_FILE = previous
    rmSync(root, { recursive: true, force: true })
  }
})

test('init, status, and audit form a continuous CLI chain', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-chain-'))
  const sdd = join(root, 'task.sdd.md')
  try {
    writeFileSync(sdd, '# Contract\n')
    const init = Bun.spawnSync([
      process.execPath,
      `${import.meta.dir}/../scripts/main.ts`,
      'init',
      '--sdd',
      sdd
    ])
    expect(init.exitCode).toBe(0)
    const status = Bun.spawnSync([
      process.execPath,
      `${import.meta.dir}/../scripts/main.ts`,
      'status',
      '--sdd',
      sdd
    ])
    expect(status.exitCode).toBe(0)
    expect(JSON.parse(status.stdout.toString())).toMatchObject({
      phase: 'DISCOVER',
      authorityEpoch: 1
    })
    const audit = Bun.spawnSync([
      process.execPath,
      `${import.meta.dir}/../scripts/main.ts`,
      'audit',
      '--sdd',
      sdd
    ])
    expect(audit.exitCode).toBe(0)
    expect(JSON.parse(audit.stdout.toString())).toMatchObject({
      protocol: 'audit/v1',
      pendingTransaction: false,
      eventLog: { valid: true }
    })
  } finally {
    rmSync(root, { recursive: true })
  }
})

test('context-view returns source fragments and hashes without a summary', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-context-'))
  const sdd = join(root, 'task.sdd.md')
  try {
    writeFileSync(sdd, '# Contract\n\n## Scope\n\nPC01 details\n')
    const result = Bun.spawnSync([
      process.execPath,
      `${import.meta.dir}/../scripts/main.ts`,
      'context-view',
      '--sdd',
      sdd
    ])
    expect(result.exitCode).toBe(0)
    const output = JSON.parse(result.stdout.toString()) as {
      protocol: string
      source: { bytes: number; sha256: string }
      sections: unknown[]
      note: string
    }
    expect(output.protocol).toBe('context-view/v2')
    expect(output.source.bytes).toBeGreaterThan(0)
    expect(output.source.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(output.sections.length).toBe(2)
    expect(output.note).toContain('no model summary')
  } finally {
    rmSync(root, { recursive: true })
  }
})

test('resume-view and audit expose continuity facts without writing', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-resume-'))
  const sdd = join(root, 'task.sdd.md')
  try {
    writeFileSync(sdd, '# Contract\n')
    writeFileSync(
      `${sdd}.loop.json`,
      JSON.stringify({ protocol: 'control-plane/state-v2', phase: 'IMPLEMENT' })
    )
    writeFileSync(`${sdd}.events.jsonl`, '')
    writeFileSync(`${sdd}.transaction.json`, 'pending')
    const result = Bun.spawnSync([
      process.execPath,
      `${import.meta.dir}/../scripts/main.ts`,
      'resume-view',
      '--sdd',
      sdd
    ])
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      protocol: 'resume-view/v1',
      audit: { pendingTransaction: true }
    })
    expect(readdirSync(root).sort()).toEqual(
      [
        'task.sdd.md',
        'task.sdd.md.events.jsonl',
        'task.sdd.md.loop.json',
        'task.sdd.md.transaction.json'
      ].sort()
    )
  } finally {
    rmSync(root, { recursive: true })
  }
})

test('runtime-view reports no lease without inferring host identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-runtime-'))
  const sdd = join(root, 'task.sdd.md')
  try {
    writeFileSync(sdd, '# Contract\n')
    writeFileSync(
      `${sdd}.loop.json`,
      JSON.stringify({ protocol: 'control-plane/state-v2', phase: 'IMPLEMENT' })
    )
    writeFileSync(`${sdd}.events.jsonl`, '')
    const result = Bun.spawnSync([
      process.execPath,
      `${import.meta.dir}/../scripts/main.ts`,
      'runtime-view',
      '--sdd',
      sdd
    ])
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      protocol: 'runtime-view/v1',
      eligible: false,
      exclusion: 'NO_ACTIVE_LEASE'
    })
  } finally {
    rmSync(root, { recursive: true })
  }
})

test('runtime-view reports lease evidence gaps and expiry instead of granting reuse', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-runtime-expired-'))
  const sdd = join(root, 'task.sdd.md')
  try {
    writeFileSync(sdd, '# Contract\n')
    writeFileSync(
      `${sdd}.loop.json`,
      JSON.stringify({
        protocol: 'control-plane/state-v2',
        phase: 'IMPLEMENT',
        authority_epoch: 2,
        active_lease: {
          lease_id: 'lease',
          agent_id: 'agent-1',
          role: 'operator',
          authority_epoch: 2,
          issued_at: '2000-01-01T00:00:00Z',
          hard_deadline_minutes: 5
        }
      })
    )
    writeFileSync(`${sdd}.events.jsonl`, '')
    const view = runtimeView(sdd) as { eligible: boolean; reasons: string[] }
    expect(view.eligible).toBe(false)
    expect(view.reasons).toContain('AGENT_LEASE_EXPIRED')
  } finally {
    rmSync(root, { recursive: true })
  }
})

test('runtime-view keeps incomplete lease facts non-reusable', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-runtime-incomplete-'))
  const sdd = join(root, 'task.sdd.md')
  try {
    writeFileSync(sdd, '# Contract\n')
    writeFileSync(
      `${sdd}.loop.json`,
      JSON.stringify({
        protocol: 'control-plane/state-v2',
        phase: 'IMPLEMENT',
        active_lease: { deadline: Date.now() / 1000 + 3600 }
      })
    )
    writeFileSync(`${sdd}.events.jsonl`, '')
    const view = runtimeView(sdd) as { eligible: boolean; reasons: string[] }
    expect(view.eligible).toBe(false)
    expect(view.reasons).toEqual(
      expect.arrayContaining(['LEASE_AGENT_ID_UNRECORDED', 'LEASE_ROLE_UNRECORDED'])
    )
  } finally {
    rmSync(root, { recursive: true })
  }
})

test('context-read is bounded and reports continuation instead of false completeness', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-read-'))
  const sdd = join(root, 'task.sdd.md')
  try {
    writeFileSync(sdd, '0123456789')
    const first = Bun.spawnSync([
      process.execPath,
      `${import.meta.dir}/../scripts/main.ts`,
      'context-read',
      '--sdd',
      sdd,
      '--offset',
      '0',
      '--limit',
      '4'
    ])
    expect(first.exitCode).toBe(0)
    expect(JSON.parse(first.stdout.toString())).toMatchObject({
      text: '0123',
      complete: false,
      nextOffset: 4,
      totalBytes: 10
    })
    const invalid = Bun.spawnSync([
      process.execPath,
      `${import.meta.dir}/../scripts/main.ts`,
      'context-read',
      '--sdd',
      sdd,
      '--offset',
      '0',
      '--limit',
      '0'
    ])
    expect(invalid.exitCode).toBe(2)
    expect(invalid.stderr.toString()).toContain('CONTEXT_LIMIT_INVALID')
  } finally {
    rmSync(root, { recursive: true })
  }
})

test('context-read keeps UTF-8 characters intact when a page cuts through a code point', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-context-utf8-'))
  const sdd = join(root, 'task.sdd.md')
  try {
    writeFileSync(sdd, 'a😀b')
    const result = contextRead(sdd, 2, 1) as { text: string; actualOffset: number; end: number }
    expect(result.text).toBe('😀')
    expect(result.actualOffset).toBe(1)
    expect(result.end).toBe(5)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('context-read rejects an offset beyond the source instead of claiming completeness', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-context-range-'))
  const sdd = join(root, 'task.sdd.md')
  try {
    writeFileSync(sdd, 'short')
    expect(() => contextRead(sdd, 999, 10)).toThrow('CONTEXT_OFFSET_OUT_OF_RANGE')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runtime context carries one invocation while command identities stay distinct', () => {
  const now = () => 1_000
  const input = {
    protocol: 'skill-invocation/v1',
    invocation_id: 'inv-1',
    started_at: '2026-09-13T00:00:00Z',
    origin: 'explicit'
  } as const
  const first = createContext(input, '/tmp/task.sdd.md', now)
  const second = createContext(input, '/tmp/task.sdd.md', now)
  expect(first.skill.invocation.invocation_id).toBe('inv-1')
  expect(first.commandId).not.toBe(second.commandId)
  expect(() =>
    assertCurrentLease(
      first,
      {
        active: true,
        deadline: 2_000,
        epoch: 3,
        agentId: 'agent-1',
        leaseId: 'lease-1'
      },
      { epoch: 3, agentId: 'agent-1', leaseId: 'lease-1' }
    )
  ).not.toThrow()
  expect(() =>
    assertCurrentLease(
      first,
      {
        active: true,
        deadline: 2_000,
        epoch: 3,
        agentId: 'agent-1',
        leaseId: 'lease-1'
      },
      { epoch: 2, agentId: 'agent-1', leaseId: 'lease-1' }
    )
  ).toThrow('LEASE_BINDING_MISMATCH')
})

test('transaction commits signed state atomically and recovery is idempotent', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-transaction-'))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  try {
    writeFileSync(join(root, 'state'), 's0')
    writeFileSync(join(root, 'events'), 'e0')
    const stages: string[] = []
    commit(
      root,
      privateKey,
      (state, events) => ({ nextState: `${state}:next`, nextEvents: `${events}:next` }),
      (stage) => stages.push(stage)
    )
    expect(stages).toEqual(['journal', 'events', 'state', 'cleanup'])
    expect(existsSync(join(root, 'journal'))).toBe(false)
    expect(recover(root, publicKey)).toBe('nothing-pending')
  } finally {
    rmSync(root, { recursive: true })
  }
})

test('sidecar commit rejects stale state or events and accepts the current snapshot', () => {
  const root = mkdtempSync(join(tmpdir(), 'sidecar-cas-'))
  const files = {
    state: join(root, 'state'),
    events: join(root, 'events'),
    journal: join(root, 'journal'),
    lock: join(root, 'lock')
  }
  const security = { sign: () => 'proof', verify: () => true }
  try {
    writeFileSync(files.state, 'current-state')
    writeFileSync(files.events, 'current-events')
    expect(() =>
      Reflect.apply(commitSidecar, undefined, [
        files,
        Buffer.from('next-state'),
        Buffer.from('next-events'),
        security
      ])
    ).toThrow('CONTROL_TRANSACTION_SNAPSHOT_REQUIRED')
    expect(readFileSync(files.state, 'utf8')).toBe('current-state')
    expect(readFileSync(files.events, 'utf8')).toBe('current-events')
    expect(existsSync(files.lock)).toBe(false)
    expect(existsSync(files.journal)).toBe(false)
    // State binds the log, so a decision made on any other state is stale.
    for (const state of ['old-state']) {
      expect(() =>
        commitSidecar(files, Buffer.from('next-state'), Buffer.from('next-events'), security, {
          state: Buffer.from(state)
        })
      ).toThrow('CONTROL_TRANSACTION_STALE_SNAPSHOT')
      expect(readFileSync(files.state, 'utf8')).toBe('current-state')
      expect(readFileSync(files.events, 'utf8')).toBe('current-events')
      expect(existsSync(files.journal)).toBe(false)
      expect(existsSync(files.lock)).toBe(false)
    }
    commitSidecar(files, Buffer.from('next-state'), Buffer.from('next-events'), security, {
      state: Buffer.from('current-state')
    })
    expect(readFileSync(files.state, 'utf8')).toBe('next-state')
    // Commits append to the log.
    expect(readFileSync(files.events, 'utf8')).toBe('current-eventsnext-events')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('sidecar transaction recovers an interrupted event/state pair from its journal', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-sidecar-tx-'))
  const files = {
    state: join(root, 'state'),
    events: join(root, 'events'),
    journal: join(root, 'journal'),
    lock: join(root, 'lock')
  }
  try {
    writeFileSync(files.state, 'before-state')
    writeFileSync(files.events, 'before-events')
    const security = {
      sign: (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
      verify: (bytes: Uint8Array, proof: string) =>
        createHash('sha256').update(bytes).digest('hex') === proof
    }
    expect(() =>
      commitSidecar(
        files,
        Buffer.from('after-state'),
        Buffer.from('after-events'),
        security,
        { state: Buffer.from('before-state') },
        (stage) => {
          if (stage === 'events') throw new Error('INJECTED_AFTER_EVENTS')
        }
      )
    ).toThrow('INJECTED_AFTER_EVENTS')
    expect(existsSync(files.journal)).toBe(true)
    expect(recoverSidecar(files, security)).toBe('recovered')
    expect(readFileSync(files.state, 'utf8')).toBe('after-state')
    // The journal appends exactly once, however far the interrupted write got.
    expect(readFileSync(files.events, 'utf8')).toBe('before-eventsafter-events')
    expect(recoverSidecar(files, security)).toBe('nothing-pending')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('sidecar recovery rejects a forged journal before touching state or events', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-loop-sidecar-forge-'))
  const files = {
    state: join(root, 'state'),
    events: join(root, 'events'),
    journal: join(root, 'journal'),
    lock: join(root, 'lock')
  }
  const security = {
    sign: (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
    verify: (bytes: Uint8Array, proof: string) =>
      createHash('sha256').update(bytes).digest('hex') === proof
  }
  try {
    writeFileSync(files.state, 'before-state')
    writeFileSync(files.events, 'before-events')
    expect(() =>
      commitSidecar(
        files,
        Buffer.from('after-state'),
        Buffer.from('after-events'),
        security,
        { state: Buffer.from('before-state') },
        () => {
          throw new Error('INJECTED_BEFORE_EVENTS')
        }
      )
    ).toThrow('INJECTED_BEFORE_EVENTS')
    const forged = JSON.parse(readFileSync(files.journal, 'utf8')) as Record<string, unknown>
    forged.afterStateBytes = Buffer.from('attacker-state').toString('base64')
    writeFileSync(files.journal, JSON.stringify(forged))
    expect(() => recoverSidecar(files, security)).toThrow(
      'CONTROL_TRANSACTION_JOURNAL_SIGNATURE_INVALID'
    )
    expect(readFileSync(files.state, 'utf8')).toBe('before-state')
    expect(readFileSync(files.events, 'utf8')).toBe('before-events')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('lease policy binds identity, role, epoch, deadline, and scope', () => {
  const lease = {
    id: 'l1',
    agentId: 'a1',
    role: 'Operator' as const,
    epoch: 2,
    deadline: 500,
    scope: ['src/index.ts']
  }
  expect(() =>
    assertLease(lease, {
      leaseId: 'l1',
      agentId: 'a1',
      role: 'Operator',
      epoch: 2,
      now: 100,
      path: 'src/index.ts'
    })
  ).not.toThrow()
  expect(() =>
    assertLease(lease, { leaseId: 'l1', agentId: 'a1', role: 'Architect', epoch: 2, now: 100 })
  ).toThrow('LEASE_AUTHORITY_MISMATCH')
  expect(() =>
    assertLease(lease, {
      leaseId: 'l1',
      agentId: 'a1',
      role: 'Operator',
      epoch: 2,
      now: 100,
      path: 'src/other.ts'
    })
  ).toThrow('LEASE_SCOPE_DENIED')
  expect(() =>
    assertLease(lease, { leaseId: 'l1', agentId: 'a1', role: 'Operator', epoch: 2, now: 500 })
  ).toThrow('LEASE_EXPIRED')
  for (const deadline of [NaN, Infinity, -Infinity]) {
    expect(() =>
      assertLease(
        { ...lease, deadline },
        {
          leaseId: 'l1',
          agentId: 'a1',
          role: 'Operator',
          epoch: 2,
          now: 100
        }
      )
    ).toThrow('LEASE_EXPIRED')
  }
})

test('phase policy allows only bounded forward or recovery transitions', () => {
  expect(() => assertPhaseTransition('DISCOVER', 'ARCHITECT')).not.toThrow()
  expect(() => assertPhaseTransition('FINAL_CANDIDATE', 'FINAL_VERIFY')).not.toThrow()
  expect(() => assertPhaseTransition('FINAL_VERIFY', 'DISCOVER')).toThrow('PHASE_TRANSITION_DENIED')
  expect(() => assertPhaseTransition('SHIP', 'ARCHITECT')).toThrow('PHASE_TRANSITION_DENIED')
})

test('loop state reducer increments revision only for an allowed phase transition', () => {
  expect(transitionPhase({ phase: 'DISCOVER', revision: 4 }, 'ARCHITECT')).toEqual({
    phase: 'ARCHITECT',
    revision: 5
  })
  expect(() => transitionPhase({ phase: 'SHIP', revision: 4 }, 'ARCHITECT')).toThrow(
    'PHASE_TRANSITION_DENIED'
  )
})

test('scope policy normalizes manifest identity to its frozen package root', () => {
  const mappings = [{ root: 'packages/web-rpc', identity: '@migaia/web-rpc' }]
  expect(normalizeOwner('@migaia/web-rpc', mappings)).toBe('packages/web-rpc')
  expect(() =>
    assertPathInScope('packages/web-rpc/test/endpoint.ts', ['@migaia/web-rpc'], mappings)
  ).not.toThrow()
  expect(() => assertPathInScope('packages/other/index.ts', ['@migaia/web-rpc'], mappings)).toThrow(
    'LEASE_SCOPE_DENIED'
  )
  expect(() => assertPathInScope('src/index.ts', ['src/index.ts'], [])).not.toThrow()
  expect(() => assertPathInScope('src/other.ts', ['src/index.ts'], [])).toThrow(
    'LEASE_SCOPE_DENIED'
  )
})

test('dispatch planner binds lease and phase before producing an immutable plan', () => {
  const lease = {
    id: 'l1',
    agentId: 'a1',
    role: 'Operator' as const,
    epoch: 2,
    deadline: 500,
    scope: ['src/index.ts']
  }
  expect(
    planDispatch(
      lease,
      { leaseId: 'l1', agentId: 'a1', role: 'Operator', epoch: 2, now: 100 },
      'DISCOVER',
      'ARCHITECT'
    )
  ).toMatchObject({ leaseId: 'l1', to: 'ARCHITECT' })
  expect(() =>
    planDispatch(
      lease,
      { leaseId: 'l1', agentId: 'a1', role: 'Operator', epoch: 1, now: 100 },
      'DISCOVER',
      'ARCHITECT'
    )
  ).toThrow('LEASE_AUTHORITY_MISMATCH')
})

test('ship policy requires every must-ship requirement verified against the current candidate', () => {
  const requirements = [
    { id: 'XQ01', kind: 'must-ship', status: 'verified', candidateId: 'c1' },
    { id: 'XQ02', kind: 'must-ship', status: 'verified', candidateId: 'c1' }
  ]
  expect(() => assertShip(requirements, 'c1')).not.toThrow()
  expect(() => assertShip([{ ...requirements[0]!, status: 'deferred' }], 'c1')).toThrow(
    'SHIP_REQUIREMENTS_UNVERIFIED'
  )
  expect(() => assertShip(requirements, 'c2')).toThrow('SHIP_CANDIDATE_MISMATCH')
  expect(() => assertShip([{ id: 'XQ03', kind: 'must-ship', status: 'deferred' }], 'c1')).toThrow(
    'SHIP_REQUIREMENTS_UNVERIFIED'
  )
  const deferred = {
    id: 'XQ03',
    kind: 'must-ship',
    status: 'deferred',
    deferred: {
      owner: 'team',
      trigger: 'next release',
      impact: 'delayed feature',
      approvedBy: 'user'
    }
  }
  expect(() => assertShip([...requirements, deferred], 'c1')).not.toThrow()
  expect(() => assertShip([...requirements, { ...deferred, status: 'pending' }], 'c1')).toThrow(
    'SHIP_REQUIREMENTS_UNVERIFIED'
  )
  for (const field of ['owner', 'trigger', 'impact', 'approvedBy']) {
    expect(() =>
      assertShip(
        [...requirements, { ...deferred, deferred: { ...deferred.deferred, [field]: ' ' } }],
        'c1'
      )
    ).toThrow('SHIP_REQUIREMENTS_UNVERIFIED')
  }
})

test('requirement policy validates deferrals and computes the effective ship set', () => {
  const deferred = {
    id: 'XQ03',
    kind: 'must-ship',
    status: 'deferred' as const,
    deferred: { owner: 'team', trigger: 'provider', impact: 'low', approvedBy: 'user' }
  }
  expect(() => assertRequirementStatus(deferred)).not.toThrow()
  expect(effectiveMustShipRequirements([deferred])).toHaveLength(0)
  expect(() =>
    assertRequirementStatus({
      ...deferred,
      deferred: { ...deferred.deferred, approvedBy: 'coordinator' }
    })
  ).toThrow('MUST_SHIP_DEFERRAL_REQUIRES_USER')
  expect(() => assertRequirementStatus({ ...deferred, status: 'verified' })).toThrow(
    'VERIFIED_REQUIRES_EVIDENCE'
  )
})

test('runtime reuse requires the same identity, role, task, lease, and healthy capabilities', () => {
  const input = {
    requestedRole: 'Operator' as const,
    runtimeRole: 'Operator',
    agentId: 'agent-1',
    expectedAgentId: 'agent-1',
    taskId: 'task-1',
    runtimeTaskId: 'task-1',
    leaseValid: true,
    stopped: false,
    capabilityIncidentOpen: false
  }
  expect(assessRuntimeReuse(input)).toEqual({ reusable: true, reasons: [] })
  expect(
    assessRuntimeReuse({
      ...input,
      expectedAgentId: 'agent-2',
      runtimeRole: 'Architect',
      taskId: 'task-2',
      leaseValid: false,
      stopped: true,
      capabilityIncidentOpen: true
    })
  ).toMatchObject({
    reusable: false,
    reasons: [
      'RUNTIME_IDENTITY_MISMATCH',
      'RUNTIME_ROLE_MISMATCH',
      'RUNTIME_TASK_MISMATCH',
      'RUNTIME_LEASE_INVALID',
      'RUNTIME_STOPPED',
      'RUNTIME_CAPABILITY_INCIDENT'
    ]
  })
})

test('readback binds the current guidance and confirms an actionable next step', () => {
  const readback = {
    role: 'Operator' as const,
    guidanceId: 'guidance-1',
    objective: '完成入口实现',
    nextAction: '修改目标文件并运行单测',
    checkMethod: '执行 bun test',
    stopCondition: '工具结果与 manifest 完整后交接'
  }
  expect(() => assertReadback(readback, 'Operator', 'guidance-1')).not.toThrow()
  expect(() =>
    assertReadback({ ...readback, guidanceId: 'guidance-2' }, 'Operator', 'guidance-1')
  ).toThrow('READBACK_GUIDANCE_MISMATCH')
  expect(() => assertReadback({ ...readback, nextAction: ' ' }, 'Operator', 'guidance-1')).toThrow(
    'READBACK_FIELD_REQUIRED'
  )
})

test('continuation and ordinary progress preserve product attempts', () => {
  const state = { completed: 2, failures: 1 }
  expect(applyAttemptEvent(state, 'continuation')).toEqual(state)
  expect(applyAttemptEvent(state, 'progress')).toEqual(state)
  expect(applyAttemptEvent(state, 'product-failure')).toEqual({ completed: 2, failures: 2 })
  expect(() => applyAttemptEvent({ completed: -1, failures: 0 }, 'progress')).toThrow(
    'ATTEMPT_STATE_INVALID'
  )
})
