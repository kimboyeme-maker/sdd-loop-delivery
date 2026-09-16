import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import {
  readProgram,
  programHash,
  programDefinitionHash as definitionHash
} from './program-contract'
import type { ProgramDocument } from './program-contract'
import { hostProfile } from '../config/host'
import { validateDocument } from '../controllers/document.controller'
import {
  bindProgramChild,
  programGit,
  readProgramRun,
  withProgramLock,
  writeProgramFile
} from '../resource/program-store'
import type { ProgramRun } from '../resource/program-store'
import { sidecarPaths, readSnapshot } from '../resource/state'
import { loadControl, assertExecutableControl } from './control-kernel'
import { assertAuthenticCurrentEpoch } from './event-authentication'
import {
  programProjection,
  captureProgramHandoff,
  assertCommittedAssets,
  programChildQuiescent
} from './program-evidence'
import { assertLockOwnerNotRunning, lockOwner } from '../resource/store/control-lock'
import { hostname } from 'node:os'
import { unlinkSync, closeSync } from 'node:fs'
import { acquireControlLock } from '../resource/store/control-lock'
import { assertProgramExecution } from './program-execution'

type Input = Record<string, unknown>
type Observation = {
  bundle_id: string
  phase: string
  commit: string | null
  reason: string | null
  wait_reason?: string | null
  stopped?: boolean
}
const requireText = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`PROGRAM_FIELD_REQUIRED: ${name}`)
  return v
}
/** Explicit run paths remain usable when the root SDD has been removed. */
const statePath = (p: string): string =>
  p.endsWith('.workflow.json')
    ? resolve(p)
    : `${existsSync(p) ? realpathSync(p) : resolve(p)}.workflow.json`
/** Compare delivered bytes across a commit without pretending a changed Git index is the old candidate. */
function assertHandoffUnchanged(
  sdd: string,
  handoff: NonNullable<import('../resource/program-store').ProgramSlot['handoff']>
): void {
  const observed = programProjection(sdd)
  if (handoff.product_hash !== observed.product_hash || handoff.event_hash !== observed.event_hash)
    throw new Error('PROGRAM_HANDOFF_CHANGED')
}

/** Require all product files to be committed before pinning an immutable release. */
function assertCommittedWorktree(sdd: string, worktree: string): void {
  if (programGit(worktree, 'diff', 'HEAD', '--name-only'))
    throw new Error('PROGRAM_UNCOMMITTED_PRODUCT')
  const untracked = programGit(worktree, 'ls-files', '-z', '--others', '--exclude-standard')
    .split('\0')
    .filter(Boolean)
  const allowed = new Set(
    [...Object.values(sidecarPaths(sdd)), sdd].map((p) => relative(worktree, p))
  )
  if (untracked.some((p) => !allowed.has(p))) throw new Error('PROGRAM_UNTRACKED_PRODUCT')
}

/** Bound objects remain on disk even after a response ends; only the owner token mutates them. */
function authorize(run: ProgramRun, input: Input): void {
  const file = process.env.SDD_PROGRAM_TOKEN_FILE
  if (!file || programHash(readFileSync(file)) !== run.token_hash)
    throw new Error('PROGRAM_AUTH_REQUIRED')
  // Task, wake and receipt identifiers only mean something to the host that issued them.
  if (run.host_profile !== hostProfile().id) throw new Error('PROGRAM_HOST_MISMATCH')
  if (input.scheduler_task_id !== run.scheduler_task_id)
    throw new Error('PROGRAM_SCHEDULER_MISMATCH')
  if (input.expected_revision !== run.revision) throw new Error('PROGRAM_REVISION_MISMATCH')
}

/** A scheduled workflow dispatches only after its recurring wake is recorded. */
const awaitingWake = (run: ProgramRun): boolean => run.wake_mode === 'scheduled' && !run.wake_id

/** Verify the child controller's own history, never a host message saying "done". */
function observe(d: ProgramDocument, run: ProgramRun): Observation[] {
  return d.bundles.map((b) => {
    const slot = run.slots[b.id]
    if (!slot) return { bundle_id: b.id, phase: 'NOT_STARTED', commit: null, reason: null }
    if (slot.creation_state === 'FAILED')
      return {
        bundle_id: b.id,
        phase: 'NOT_STARTED',
        commit: null,
        reason: 'Confirmed no task was created; an explicit creation retry is required.',
        wait_reason: 'CREATION_RETRY_REQUIRED',
        stopped: true
      }
    if (!slot.sdd)
      return {
        bundle_id: b.id,
        phase: 'BOOTSTRAP_PENDING',
        commit: null,
        reason: 'Reconcile the recorded host creation intent; never recreate blindly.'
      }
    if (!existsSync(sidecarPaths(slot.sdd).state))
      return {
        bundle_id: b.id,
        phase: 'BOOTSTRAP_PENDING',
        commit: null,
        reason: 'Bound task has not initialized its delivery.'
      }
    let phase = 'UNREADABLE'
    try {
      if (programHash(readFileSync(slot.sdd)) !== programHash(readFileSync(d.files[b.owner]!)))
        throw new Error('PROGRAM_CHILD_SOURCE_DIVERGED')
      const c = loadControl(slot.sdd)
      assertExecutableControl(slot.sdd, c)
      assertAuthenticCurrentEpoch(c.state, c.events())
      phase = String(c.state.phase)
      let commit: string | null = null
      const stopped =
        !!slot.stopped &&
        programChildQuiescent(c.state) &&
        slot.stopped.event_hash === programHash(JSON.stringify(c.events()))
      if (phase === 'SHIP') {
        if (!slot.handoff)
          throw new Error(
            'PROGRAM_HANDOFF_REQUIRED: record handoff before committing the verified candidate'
          )
        assertHandoffUnchanged(slot.sdd, slot.handoff)
        // Product changes must have an explicit committed handoff. Commit permission is separate.
        assertCommittedWorktree(slot.sdd, slot.worktree!)
        if (!slot.release_commit) throw new Error('PROGRAM_RELEASE_COMMIT_REQUIRED')
        commit = slot.release_commit
        for (const required of slot.required_commits)
          programGit(slot.worktree!, 'merge-base', '--is-ancestor', required, commit)
        assertCommittedAssets(slot.worktree!, commit, slot.handoff)
      }
      const terminal = ['SHIP', 'BLOCKED', 'CANCELLED'].includes(phase)
      const wait = terminal
        ? stopped
          ? null
          : 'WRITER_STOP_REQUIRED'
        : c.state.pending_user_decision
          ? 'USER_DECISION'
          : slot.allowance > 0 && slot.reserved_seconds >= slot.allowance
            ? 'BUDGET_DECISION'
            : null
      return { bundle_id: b.id, phase, commit, reason: null, wait_reason: wait, stopped }
    } catch (e) {
      return {
        bundle_id: b.id,
        phase,
        commit: null,
        reason: e instanceof Error ? e.message : 'PROGRAM_CHILD_UNREADABLE',
        wait_reason: 'USER_DECISION',
        stopped: false
      }
    }
  })
}

/** Derive state from actual children; runtime records contain no copied product verdict. */
function view(d: ProgramDocument, run: ProgramRun): object {
  const children = observe(d, run),
    shipped = new Set(
      children.filter((c) => c.phase === 'SHIP' && c.commit).map((c) => c.bundle_id)
    )
  const active = children.filter((c) => run.slots[c.bundle_id] && !c.stopped).length
  const ready = d.bundles
    .filter((b) => !run.slots[b.id] && d.dependencies[b.id]!.every((id) => shipped.has(id)))
    .map((b) => b.id)
  const entriesComplete = d.program.metas
    .filter((m) => m.kind === 'Entry')
    .every((entry) => {
      if (
        !entry.members.every((id) => {
          const owner = d.program.metas.find((m) => m.id === id)!.owner
          return shipped.has(d.bundles.find((b) => b.owner === owner)!.id)
        })
      )
        return false
      const validator = entry.validators.implementation
      if (!validator.acceptance_ids.length) return true
      const producer = d.bundles.find((b) => b.owner === validator.owner)
      const proof = producer && run.slots[producer.id]?.handoff?.acceptance_events
      return !!proof && validator.acceptance_ids.every((id) => !!proof[id])
    })
  const status = run.paused
    ? 'PAUSED'
    : shipped.size === d.bundles.length && entriesComplete && active === 0
      ? 'COMPLETE'
      : awaitingWake(run)
        ? 'WAITING_HOST'
        : children.some((c) => c.wait_reason && c.wait_reason !== 'BUDGET_DECISION')
          ? 'WAITING_USER'
          : children.some((c) => c.wait_reason === 'BUDGET_DECISION')
            ? 'WAITING_BUDGET'
            : children.some((c) => ['BLOCKED', 'CANCELLED'].includes(c.phase)) &&
                !active &&
                !ready.length
              ? 'FAILED'
              : active || ready.length
                ? 'WORKING'
                : 'WAITING_DEPENDENCY'
  return {
    protocol: run.protocol,
    program: run.program,
    revision: run.revision,
    status,
    scheduler_task_id: run.scheduler_task_id,
    host_profile: run.host_profile,
    wake_mode: run.wake_mode,
    wake_id: run.wake_id,
    children,
    ready: ready.slice(0, Math.max(0, run.max_parallel - active)),
    active,
    tasks: Object.entries(run.slots).map(([id, s]) => ({
      bundle_id: id,
      intent_id: s.intent_id,
      task_id: s.task_id,
      sdd: s.sdd,
      worktree: s.worktree,
      allowance_seconds: s.allowance,
      reserved_seconds: s.reserved_seconds,
      remaining_reservable_seconds: Math.max(0, s.allowance - s.reserved_seconds),
      creation_state: s.creation_state,
      previous_attempts: s.previous_attempts ?? [],
      release_commit: s.release_commit ?? null
    })),
    total_test_seconds: run.total_test_seconds,
    note: 'Reserved time is a conservative ceiling, not actual credits. Parent documents do not run child work again.'
  }
}

/** Start publishes once, never implicitly replaces a previous workflow or resets its budget. */
export function programStart(path: string, raw: Input): object {
  const input = raw
  const d = readProgram(path),
    file = statePath(path)
  // A child the controller would reject at its own admission must not consume a task or budget.
  const invalid = d.program.nodes
    .filter((n) => n.kind === 'execution')
    .map((n) => [n.id, validateDocument(d.files[n.id]!)] as const)
    .filter(([, result]) => !result.valid)
  if (invalid.length)
    throw new Error(
      `PROGRAM_CHILD_INVALID: ${invalid.map(([id, r]) => `${id} ${r.diagnostics[0]?.code ?? 'INVALID'}`).join(', ')}`
    )
  return withProgramLock(file, () => {
    if (existsSync(file)) throw new Error('PROGRAM_ALREADY_STARTED: use program-resume')
    const scheduler = requireText(input.scheduler_task_id, 'scheduler_task_id')
    const auth = requireText(input.authorization_ref, 'authorization_ref')
    const parallel = input.max_parallel,
      budget = input.total_test_seconds
    if (
      typeof parallel !== 'number' ||
      typeof budget !== 'number' ||
      !Number.isSafeInteger(parallel) ||
      parallel < 1 ||
      parallel > d.program.execution.max_parallel ||
      !Number.isSafeInteger(budget) ||
      budget < 0 ||
      budget > d.program.execution.total_test_seconds ||
      Object.values(d.program.execution.allocations).reduce((a, b) => a + b, 0) > budget
    )
      throw new Error('PROGRAM_AUTHORIZED_LIMIT_INVALID')
    const host = hostProfile()
    const optionalText = (v: unknown, name: string): string | null =>
      v === undefined || v === null ? null : requireText(v, name)
    const wakeMode =
      input.wake_mode ?? (host.operations.wake_schedule.available ? 'scheduled' : 'attended')
    if (wakeMode !== 'scheduled' && wakeMode !== 'attended')
      throw new Error('PROGRAM_WAKE_MODE_INVALID')
    if (wakeMode === 'scheduled' && !host.operations.wake_schedule.available)
      throw new Error('PROGRAM_HOST_OPERATION_UNAVAILABLE: wake_schedule')
    const baseCommit = programGit(
      dirname(d.path),
      'rev-parse',
      '--verify',
      `${d.program.execution.base_ref}^{commit}`
    )
    const tokenFile = `${file}.token`
    // A failed initial publication may leave only the private token; reuse it, never rotate it.
    if (!existsSync(tokenFile)) writeProgramFile(tokenFile, `${randomUUID()}${randomUUID()}`)
    const run: ProgramRun = {
      protocol: 'sdd-workflow/v1',
      program: d.path,
      fingerprint: d.fingerprint,
      revision: 1,
      scheduler_task_id: scheduler,
      token_hash: programHash(readFileSync(tokenFile)),
      authorization_ref: auth,
      host_profile: host.id,
      project_ref: optionalText(input.project_ref, 'project_ref'),
      host_ref: optionalText(input.host_ref, 'host_ref'),
      wake_mode: wakeMode,
      wake_id: null,
      paused: false,
      max_parallel: parallel,
      total_test_seconds: budget,
      slots: {},
      base_commit: baseCommit
    }
    writeProgramFile(file, run)
    return {
      ...view(d, run),
      token_file: tokenFile,
      next:
        wakeMode === 'scheduled'
          ? 'Create one recurring wake through the host wake_schedule operation, then program-record action wake with the real receipt.'
          : 'Attended mode: run program-next; the workflow advances only while this scheduling task is active or resumed.'
    }
  })
}

/** Status is read-only and remains useful when a program edit requires explicit reconciliation. */
export function workflowStatus(path: string): object {
  const run = readProgramRun(statePath(path))
  return runView(run)
}

/** Source failures cannot suppress durable stop/status facts. */
function runView(run: ProgramRun): object {
  try {
    const d = readProgram(run.program)
    return {
      ...view(d, run),
      source_current: run.fingerprint === d.fingerprint,
      dispatch_allowed: !run.paused && run.fingerprint === d.fingerprint
    }
  } catch (e) {
    return {
      protocol: run.protocol,
      program: run.program,
      revision: run.revision,
      status: run.paused ? 'PAUSED' : 'WAITING_USER',
      source_current: false,
      dispatch_allowed: false,
      reason: e instanceof Error ? e.message : 'PROGRAM_SOURCE_UNREADABLE',
      tasks: Object.entries(run.slots).map(([bundle_id, s]) => ({
        bundle_id,
        intent_id: s.intent_id,
        task_id: s.task_id,
        worktree: s.worktree,
        sdd: s.sdd,
        allowance_seconds: s.allowance,
        reserved_seconds: s.reserved_seconds
      }))
    }
  }
}

/** Reserve one creation intent before a host call; pending intents consume concurrency slots. */
export function programNext(path: string, raw: Input): object {
  const input = raw
  const d = readProgram(path),
    file = statePath(path)
  return withProgramLock(file, () => {
    const run = readProgramRun(file)
    authorize(run, input)
    if (run.fingerprint !== d.fingerprint)
      throw new Error('PROGRAM_CHANGED_REQUIRES_RECONCILIATION')
    if (run.paused || awaitingWake(run)) return { ...view(d, run), action: 'WAIT' }
    const current = view(d, run) as { ready: string[] }
    const id = current.ready[0]
    if (!id) return { ...view(d, run), action: 'WAIT' }
    const b = d.bundles.find((x) => x.id === id)!
    const observed = observe(d, run)
    const commits = d.dependencies[id]!.map(
      (dep) => observed.find((x) => x.bundle_id === dep)!.commit!
    )
    // Pick one inherited baseline. Multi-parent merges are explicit work in this Bundle.
    const base = commits[0] ?? run.base_commit
    const slot = {
      intent_id: randomUUID(),
      task_id: null,
      worktree: null,
      sdd: null,
      base_commit: base,
      required_commits: commits,
      allowance: d.program.execution.allocations[id]!,
      reserved_seconds: 0,
      host_receipt: null
    }
    const boundSlot = {
      ...slot,
      definition_hash: definitionHash(d, id),
      creation_state: 'RESERVED' as const,
      ...(b.integration_batch_id ? { integration_batch_id: b.integration_batch_id } : {})
    }
    run.slots[id] = boundSlot
    run.revision += 1
    writeProgramFile(file, run)
    return creationAction(d, run, id)
  })
}

/**
 * Whether the scheduler may create this child itself. A host that can create a worktree task but
 * cannot address the one it created is no better than a host that cannot create one: the scheduler
 * would start a child it can neither drive, wait on, nor reclaim. Both route to the attended path,
 * where the user starts the task and reports its identifier; binding checks the same facts either
 * way.
 */
export function creationHostCall(
  create: Readonly<{
    available: boolean
    call?: string
    params?: readonly string[]
    reason?: string
    worktree_addressable?: boolean
  }>
): object {
  if (create.available && create.worktree_addressable !== false)
    return { operation: 'task_create', call: create.call, params: create.params ?? [] }
  return {
    operation: 'task_create',
    available: false,
    reason: create.available
      ? 'The host creates worktree-bound tasks but returns only a provisional identifier that no other call accepts, so a created child cannot be driven, waited on or reclaimed.'
      : create.reason,
    fallback: 'USER_CREATES_TASK'
  }
}

/** Every creation/retry prompt carries the actual source and frozen input versions. */
function creationAction(d: ProgramDocument, run: ProgramRun, id: string): object {
  const b = d.bundles.find((x) => x.id === id)!,
    slot = run.slots[id]!,
    create = hostProfile().operations.task_create
  return {
    ...view(d, run),
    action: 'CREATE_TASK',
    bundle_id: id,
    intent_id: slot.intent_id,
    project_ref: run.project_ref,
    host_ref: run.host_ref,
    // A child must run in its own worktree, so a host that can create a task but cannot address the
    // one it created is no better than a host that cannot create one: the scheduler would start a
    // child it can neither drive nor reclaim. Both cases route to the same attended path, where the
    // user starts the task and reports its identifier. Binding checks the same facts either way.
    host_call: creationHostCall(create),
    base_commit: slot.base_commit,
    required_commits: slot.required_commits,
    source_sdd: d.files[b.owner],
    sdd_relative: relative(
      programGit(dirname(d.path), 'rev-parse', '--show-toplevel'),
      d.files[b.owner]!
    ),
    prompt: `Workflow ${d.path}; Bundle ${id}; intent ${slot.intent_id}. Approved source SDD: ${d.files[b.owner]}. First report your actual worktree and copied SDD path, then wait for bind and CONTINUE before init or product writes. After CONTINUE use $sdd-loop-delivery on that bound SDD. Required commits: ${slot.required_commits.join(', ') || slot.base_commit}. Integration batch: ${slot.integration_batch_id ?? 'none'}. Only the declared integration batch may precede complete input ancestry. Total test reservation ${slot.allowance} seconds across all roles/retries; numeric allowance is not test permission. Preserve global user restrictions. After SHIP wait for scheduler handoff before authorized commit; then report the commit and actual writer/command stop evidence. A finished response is not delivery or writer-stop proof.`
  }
}

/** Host receipts are recorded observations, not cryptographic proof of host behavior. */
export function programRecord(path: string, raw: Input): object {
  const input = raw
  const d = readProgram(path),
    file = statePath(path)
  return withProgramLock(file, () => {
    const run = readProgramRun(file)
    authorize(run, input)
    if (input.action === 'reconcile') {
      if (!run.paused) throw new Error('PROGRAM_PAUSE_BEFORE_RECONCILIATION')
      requireText(input.authorization_ref, 'authorization_ref')
      if (
        input.total_test_seconds !== d.program.execution.total_test_seconds ||
        input.max_parallel !== d.program.execution.max_parallel
      )
        throw new Error('PROGRAM_RECONCILIATION_LIMITS_REQUIRED')
      for (const [id, slot] of Object.entries(run.slots)) {
        // A confirmed failed creation has no child state to amend. Keep its attempt and budget.
        if (slot.creation_state === 'FAILED' && !slot.sdd && !slot.task_id) {
          slot.definition_hash = definitionHash(d, id)
          const bundle = d.bundles.find((b) => b.id === id)!
          if (bundle.integration_batch_id) slot.integration_batch_id = bundle.integration_batch_id
          else delete slot.integration_batch_id
        }
        if (slot.definition_hash !== definitionHash(d, id)) {
          const evidence = (
            input.child_reconciliations as
              | Record<string, { state_hash: string; host_stop_receipt: string }>
              | undefined
          )?.[id]
          const b = d.bundles.find((item) => item.id === id)!
          if (
            !slot.sdd ||
            !evidence ||
            !requireText(evidence.host_stop_receipt, 'host_stop_receipt') ||
            evidence.state_hash !== readSnapshot(slot.sdd).stateHash ||
            programHash(readFileSync(slot.sdd)) !== programHash(readFileSync(d.files[b.owner]!))
          )
            throw new Error('PROGRAM_CHILD_AMENDMENT_REQUIRED')
          const c = loadControl(slot.sdd)
          assertExecutableControl(slot.sdd, c)
          assertAuthenticCurrentEpoch(c.state, c.events())
          if (!programChildQuiescent(c.state) || c.state.phase === 'SHIP')
            throw new Error(
              'PROGRAM_CHILD_MUST_BE_QUIESCENT: preserve shipped work; do not replace its definition'
            )
          // A dispatched child may amend its own contract, but cannot acquire new upstream inputs
          // behind an existing worktree's back. Such restructuring remains a user/design decision.
          const commits = d.dependencies[id]!.map(
            (dep) => observe(d, run).find((o) => o.bundle_id === dep)?.commit
          )
          if (
            commits.some((v) => !v) ||
            JSON.stringify(commits) !== JSON.stringify(slot.required_commits)
          )
            throw new Error('PROGRAM_DISPATCHED_DEPENDENCIES_CHANGED')
          slot.definition_hash = definitionHash(d, id)
          slot.creation_state = 'BOUND'
          if (b.integration_batch_id) slot.integration_batch_id = b.integration_batch_id
          else delete slot.integration_batch_id
        }
        const allowance = d.program.execution.allocations[id]
        if (allowance === undefined || allowance < slot.allowance)
          throw new Error('PROGRAM_ALLOCATION_CANNOT_RECLAIM')
        slot.allowance = allowance
      }
      if (input.total_test_seconds < run.total_test_seconds)
        throw new Error('PROGRAM_BUDGET_CANNOT_RECLAIM')
      run.total_test_seconds = input.total_test_seconds
      run.max_parallel = input.max_parallel
      run.authorization_ref = requireText(input.authorization_ref, 'authorization_ref')
      run.fingerprint = d.fingerprint
    } else if (run.fingerprint !== d.fingerprint && input.action !== 'creation-result')
      throw new Error('PROGRAM_CHANGED_REQUIRES_RECONCILIATION')
    else if (input.action === 'wake') {
      if (run.wake_mode !== 'scheduled') throw new Error('PROGRAM_WAKE_MODE_INVALID')
      run.wake_id = requireText(input.wake_id, 'wake_id')
      requireText(input.host_receipt, 'host_receipt')
    } else if (input.action === 'creation-result') {
      const slot = run.slots[requireText(input.bundle_id, 'bundle_id')]
      if (!slot || slot.intent_id !== input.intent_id || slot.task_id || slot.sdd)
        throw new Error('PROGRAM_INTENT_MISMATCH')
      if (!['UNKNOWN', 'NOT_CREATED'].includes(String(input.outcome)))
        throw new Error('PROGRAM_CREATION_OUTCOME_INVALID')
      const receipt = requireText(input.host_receipt, 'host_receipt')
      if (slot.creation_state === 'FAILED' && input.outcome !== 'NOT_CREATED')
        throw new Error('PROGRAM_CREATION_OUTCOME_INVALID')
      if (input.outcome === 'NOT_CREATED' && input.no_task_created !== true)
        throw new Error('PROGRAM_CREATION_CONFIRMATION_REQUIRED')
      slot.creation_state = input.outcome === 'NOT_CREATED' ? 'FAILED' : 'UNKNOWN'
      slot.host_receipt = receipt
    } else if (input.action === 'retry-creation') {
      const id = requireText(input.bundle_id, 'bundle_id'),
        slot = run.slots[id]
      if (
        !slot ||
        slot.intent_id !== input.intent_id ||
        slot.creation_state !== 'FAILED' ||
        slot.task_id ||
        slot.sdd ||
        !slot.host_receipt
      )
        throw new Error('PROGRAM_CREATION_NOT_RETRYABLE')
      if (
        run.paused ||
        awaitingWake(run) ||
        (view(d, run) as { active: number }).active >= run.max_parallel
      )
        throw new Error('PROGRAM_DISPATCH_UNAVAILABLE')
      const observed = observe(d, run)
      const commits = d.dependencies[id]!.map(
        (dep) => observed.find((o) => o.bundle_id === dep)?.commit
      )
      if (commits.some((commit) => !commit)) throw new Error('PROGRAM_INPUTS_NOT_RELEASED')
      slot.required_commits = commits as string[]
      slot.base_commit = slot.required_commits[0] ?? run.base_commit
      slot.previous_attempts = [
        ...(slot.previous_attempts ?? []),
        { intent_id: slot.intent_id, host_receipt: slot.host_receipt }
      ]
      slot.intent_id = randomUUID()
      slot.creation_state = 'RESERVED'
      slot.host_receipt = null
      run.revision += 1
      writeProgramFile(file, run)
      return creationAction(d, run, id)
    } else if (input.action === 'stopped') {
      const slot = run.slots[requireText(input.bundle_id, 'bundle_id')]
      if (!slot?.sdd || input.task_id !== slot.task_id || input.intent_id !== slot.intent_id)
        throw new Error('PROGRAM_INTENT_MISMATCH')
      const c = loadControl(slot.sdd),
        events = c.events()
      assertExecutableControl(slot.sdd, c)
      assertAuthenticCurrentEpoch(c.state, events)
      if (
        !programChildQuiescent(c.state) ||
        !['SHIP', 'BLOCKED', 'CANCELLED'].includes(String(c.state.phase)) ||
        input.writers_stopped !== true ||
        input.commands_stopped !== true
      )
        throw new Error('PROGRAM_CHILD_MUST_BE_QUIESCENT')
      slot.stopped = {
        event_hash: programHash(JSON.stringify(events)),
        host_receipt: requireText(input.host_receipt, 'host_receipt')
      }
    } else if (input.action === 'release') {
      const slot = run.slots[requireText(input.bundle_id, 'bundle_id')]
      if (!slot?.sdd || !slot.handoff) throw new Error('PROGRAM_HANDOFF_REQUIRED')
      const c = loadControl(slot.sdd)
      assertProgramExecution(slot.sdd, c.state, undefined, 'read')
      assertExecutableControl(slot.sdd, c)
      assertAuthenticCurrentEpoch(c.state, c.events())
      if (c.state.phase !== 'SHIP') throw new Error('PROGRAM_CHILD_NOT_SHIPPED')
      assertHandoffUnchanged(slot.sdd, slot.handoff)
      assertCommittedWorktree(slot.sdd, slot.worktree!)
      const requestedCommit = requireText(input.commit, 'commit')
      if (!/^[a-f0-9]{40,64}$/.test(requestedCommit))
        throw new Error('PROGRAM_RELEASE_COMMIT_INVALID')
      const commit = programGit(
        slot.worktree!,
        'rev-parse',
        '--verify',
        `${requestedCommit}^{commit}`
      )
      if (slot.release_commit && slot.release_commit !== commit)
        throw new Error('PROGRAM_RELEASE_IMMUTABLE')
      if (
        programGit(slot.worktree!, 'rev-parse', 'HEAD') !== commit ||
        programGit(slot.worktree!, 'diff', 'HEAD', '--name-only')
      )
        throw new Error('PROGRAM_UNCOMMITTED_PRODUCT')
      for (const required of slot.required_commits)
        programGit(slot.worktree!, 'merge-base', '--is-ancestor', required, commit)
      assertCommittedAssets(slot.worktree!, commit, slot.handoff)
      slot.release_commit = commit
    } else if (input.action === 'handoff') {
      const slot = run.slots[requireText(input.bundle_id, 'bundle_id')]
      if (!slot?.sdd) throw new Error('PROGRAM_CHILD_NOT_BOUND')
      const c = loadControl(slot.sdd)
      assertProgramExecution(slot.sdd, c.state, undefined, 'read')
      assertExecutableControl(slot.sdd, c)
      assertAuthenticCurrentEpoch(c.state, c.events())
      if (c.state.phase !== 'SHIP') throw new Error('PROGRAM_CHILD_NOT_SHIPPED')
      if (!slot.handoff) {
        const owner = d.bundles.find((b) => b.id === input.bundle_id)!.owner
        slot.handoff = captureProgramHandoff(d, owner, slot.sdd)
      } else assertHandoffUnchanged(slot.sdd, slot.handoff)
    } else if (input.action === 'bind') {
      const slot = run.slots[requireText(input.bundle_id, 'bundle_id')]
      if (!slot || slot.intent_id !== input.intent_id) throw new Error('PROGRAM_INTENT_MISMATCH')
      const thread = requireText(input.task_id, 'task_id')
      if (slot.task_id && slot.task_id !== thread) throw new Error('PROGRAM_TASK_ALREADY_BOUND')
      if (Object.values(run.slots).some((s) => s !== slot && s.task_id === thread))
        throw new Error('PROGRAM_TASK_DUPLICATE')
      const worktree = realpathSync(requireText(input.worktree, 'worktree'))
      const sdd = realpathSync(requireText(input.sdd, 'sdd'))
      if (slot.creation_state === 'FAILED') throw new Error('PROGRAM_CREATION_NOT_RETRYABLE')
      if ((slot.worktree && slot.worktree !== worktree) || (slot.sdd && slot.sdd !== sdd))
        throw new Error('PROGRAM_BINDING_IMMUTABLE')
      if (
        !isAbsolute(worktree) ||
        programGit(worktree, 'rev-parse', '--show-toplevel') !== worktree ||
        relative(worktree, sdd).startsWith('..') ||
        isAbsolute(relative(worktree, sdd))
      )
        throw new Error('PROGRAM_WORKTREE_INVALID')
      if (
        worktree === programGit(dirname(d.path), 'rev-parse', '--show-toplevel') ||
        Object.values(run.slots).some((s) => s !== slot && s.worktree === worktree)
      )
        throw new Error('PROGRAM_WORKTREE_SHARED')
      if (
        programGit(worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir') !==
        programGit(dirname(d.path), 'rev-parse', '--path-format=absolute', '--git-common-dir')
      )
        throw new Error('PROGRAM_REPOSITORY_MISMATCH')
      const b = d.bundles.find((x) => x.id === input.bundle_id)!
      if (programHash(readFileSync(sdd)) !== programHash(readFileSync(d.files[b.owner]!)))
        throw new Error('PROGRAM_CHILD_SOURCE_DIVERGED')
      programGit(worktree, 'merge-base', '--is-ancestor', slot.base_commit, 'HEAD')
      if (existsSync(sidecarPaths(sdd).state) && !slot.sdd)
        throw new Error('PROGRAM_CHILD_STARTED_BEFORE_BINDING')
      slot.task_id = thread
      slot.worktree = worktree
      slot.sdd = sdd
      slot.creation_state = 'BOUND'
      slot.host_receipt = requireText(input.host_receipt, 'host_receipt')
      // The marker precedes publication. A crash retries the same intent and marker, not creation.
      bindProgramChild({
        state_path: file,
        bundle_id: requireText(input.bundle_id, 'bundle_id'),
        sdd,
        intent_id: slot.intent_id
      })
    } else throw new Error('PROGRAM_RECORD_ACTION_INVALID')
    run.revision += 1
    writeProgramFile(file, run)
    return {
      ...view(d, run),
      next:
        input.action === 'bind'
          ? 'Send CONTINUE to the bound task; do not create another task.'
          : 'Run program-next.'
    }
  })
}

/** Stop prevents new dispatch; it does not pretend to stop a live child or reclaim its allowance. */
export function programPause(path: string, raw: Input, paused: boolean): object {
  const input = raw
  const file = statePath(path)
  return withProgramLock(file, () => {
    const run = readProgramRun(file)
    authorize(run, input)
    if (!paused && run.fingerprint !== readProgram(run.program).fingerprint)
      throw new Error('PROGRAM_CHANGED_REQUIRES_RECONCILIATION')
    run.paused = paused
    run.revision += 1
    writeProgramFile(file, run)
    return runView(run)
  })
}

/** Recover only the exact orphan lock after explicit user confirmation and a local liveness check. */
export function programRecoverLock(path: string, raw: Input): object {
  const input = raw
  const file = statePath(path),
    lock = `${file}.lock`,
    recovery = `${file}.recovery.lock`
  const fd = acquireControlLock(recovery)
  try {
    const run = existsSync(file) ? readProgramRun(file) : null
    if (run) authorize(run, input)
    else if (input.initial_start !== true || input.expected_revision !== 0)
      throw new Error('PROGRAM_INITIAL_RECOVERY_REQUIRED')
    const bytes = readFileSync(lock)
    if (
      input.lock_hash !== programHash(bytes) ||
      input.owner_stopped !== true ||
      !requireText(input.authorization_ref, 'authorization_ref')
    )
      throw new Error('PROGRAM_LOCK_RECOVERY_AUTH_REQUIRED')
    const owner = lockOwner(bytes)
    if (!owner || owner.host !== hostname() || owner.pid === process.pid)
      throw new Error('PROGRAM_LOCK_OWNER_UNVERIFIABLE')
    assertLockOwnerNotRunning(bytes)
    // Publish the revision while the orphan still excludes ordinary writers.
    if (run) {
      run.revision += 1
      writeProgramFile(file, run)
    }
    unlinkSync(lock)
    return { recovered: true, revision: run?.revision ?? 0 }
  } finally {
    closeSync(fd)
    unlinkSync(recovery)
  }
}
