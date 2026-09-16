import { isAbsolute, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { runBootstrapProcesses } from '../controllers/bootstrap-process'
import { contextDocumentPage } from '../services/context-document'
import {
  capabilities,
  configuration,
  contextRead,
  contextView,
  audit,
  resumeView,
  runtimeView,
  status
} from '../controllers/read-only.controller'
import {
  documentCheck,
  nextDocumentId,
  validateDocument,
  validateDraft,
  validateDraftText
} from '../controllers/document.controller'
import type { DocumentPolicy } from '../domain/document-presentation'
import { snapshotWorktree } from '../resource/worktree/snapshot'
import { preActionGate } from '../controllers/action-gate.controller'
import { hostReceipt } from '../controllers/host.controller'
import { initLoop } from '../controllers/init.controller'
import { testRun } from '../controllers/test-run.controller'
import { coordinatorBrief, coordinatorEvent } from '../services/coordinator-brief'
import { programCheck } from '../services/program-contract'
import {
  workflowStatus,
  programStart,
  programNext,
  programRecord,
  programPause,
  programRecoverLock
} from '../services/program-workflow'
import { runtimePlan } from '../services/runtime-plan'
import { processReclaim } from '../controllers/process-reclaim.controller'
import { TEST_PRESETS } from '../config/test-presets'
import { evolutionDigest, retrospective, writeRetrospective } from '../services/retrospective'
import { lintOperatorReceipt, scaffoldOperatorReceipt } from '../controllers/receipt.controller'
import { validateBootstrapPayload } from '../controllers/bootstrap.controller'
import { agentBootstrap } from '../controllers/agent-bootstrap.controller'
import { transition } from '../controllers/transition.controller'
import { transactionRecover } from '../controllers/transaction-recover.controller'
import { lockRecover } from '../controllers/lock-recover.controller'
import { recordEvent } from '../controllers/record.controller'
import { userControl } from '../controllers/user-control.controller'
import { requirementUpdate } from '../controllers/requirement.controller'
import { findingUpdate } from '../controllers/finding.controller'
import { attempt } from '../controllers/attempt.controller'
import { runtimeRecord } from '../controllers/runtime-record.controller'
import { failure } from '../controllers/failure.controller'
import { authBootstrap } from '../controllers/auth-bootstrap.controller'
import { dispatch, type DispatchOptions } from '../controllers/dispatch.controller'
import { coordinatorTakeover } from '../controllers/coordinator-takeover.controller'
import { agentStartReceipt } from '../controllers/agent-start-receipt.controller'
import { productSnapshot } from '../helpers/worktree-candidate'
import { agentRecord } from '../controllers/agent-record.controller'
import { bootstrapRecover } from '../controllers/bootstrap-recover.controller'
import { prepare } from '../controllers/prepare.controller'
import { prepareRecord } from '../controllers/prepare-record.controller'
import { operatorReconcile } from '../controllers/operator-reconcile.controller'
import { amendContract } from '../controllers/amend.controller'
import { mintRoleCapability, readCapabilityFile } from '../resource/role-capability'

/** A usage problem: reported with exit code 2 before any controller runs. */
export class UsageError extends Error {}

/** Parsed command-line flags; option names and value presence were validated before dispatch. */
export type Flags = Readonly<{
  value: (flag: string) => string | undefined
  has: (flag: string) => boolean
  all: (flag: string) => string[]
  /** Values of every flag, or a UsageError with `message` when any is missing or empty. */
  need: (message: string, ...flags: string[]) => string[]
}>

/** What a handler returns: the JSON output and its exit code (0 unless stated). */
export type Outcome = Readonly<{ output: unknown; exit?: number }>

/**
 * One command's behavior. `failure` names the error when a non-Error is thrown and
 * `failureExit` is the exit code for any controller error; usage errors always exit 2.
 */
export type Handler = Readonly<{
  failure: string
  failureExit: 1 | 2
  run: (flags: Flags) => Outcome | Promise<Outcome>
}>

export function flagsOf(args: readonly string[]): Flags {
  const value = (flag: string) => {
    const index = args.indexOf(flag)
    return index >= 0 ? args[index + 1] : undefined
  }
  return {
    value,
    has: (flag) => args.includes(flag),
    all: (flag) => args.flatMap((arg, index) => (arg === flag ? [args[index + 1] ?? ''] : [])),
    need: (message, ...flags) => {
      const values = flags.map(value)
      if (values.some((item) => !item)) throw new UsageError(message)
      return values as string[]
    }
  }
}

const SDD_REQUIRED = 'SDD_REQUIRED: pass --sdd /absolute/path/to/document.sdd.md'
const ok = (output: unknown): Outcome => ({ output })
const byValidity = (result: { valid: boolean }): Outcome => ({
  output: result,
  exit: result.valid ? 0 : 1
})
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))
const mutation = (failure: string, run: Handler['run']): Handler => ({
  failure,
  failureExit: 1,
  run
})
const report = (failure: string, run: Handler['run']): Handler => ({ failure, failureExit: 2, run })

/** Mint a Coordinator credential file when an authority change was not handed a token. */
function mintCoordinatorCredential(tokenEnv: string): string | undefined {
  if (process.env[tokenEnv]) return undefined
  const minted = mintRoleCapability(`COORDINATOR-${crypto.randomUUID()}`)
  process.env[tokenEnv] = readCapabilityFile(minted.path)
  return minted.path
}

/** Read-only projections of one SDD's controller state. */
const view = (name: string): Handler =>
  report('STATUS_FAILED', ({ value, has }) => {
    const sdd = value('--sdd')
    if (!sdd) throw new UsageError(SDD_REQUIRED)
    if (name === 'context-read') {
      const offset = has('--offset') ? Number(value('--offset')) : 0
      const limitFlag = has('--limit') ? '--limit' : '--max-bytes'
      const limit = has(limitFlag) ? Number(value(limitFlag)) : 65_536
      const role = value('--agent')
      if (!role && (has('--packet') || has('--fresh') || has('--retained-understanding')))
        throw new Error('CONTEXT_ROLE_REQUIRED')
      return ok(
        role
          ? contextDocumentPage(
              sdd,
              {
                role,
                packetId: value('--packet'),
                fresh: has('--fresh'),
                agentId: value('--agent-id'),
                retainedUnderstanding: has('--retained-understanding'),
                preparedId: value('--prepared-id')
              },
              offset,
              limit
            )
          : contextRead(sdd, offset, limit)
      )
    }
    const eventId = value('--event-id')
    const views: Record<string, () => unknown> = {
      status: () => status(sdd, has('--compact')),
      'coordinator-brief': () => (eventId ? coordinatorEvent(sdd, eventId) : coordinatorBrief(sdd)),
      audit: () => audit(sdd),
      'resume-view': () => resumeView(sdd),
      'runtime-view': () => runtimeView(sdd),
      'context-view': () =>
        contextView(sdd, value('--agent') ?? 'coordinator', value('--packet'), has('--fresh'))
    }
    return ok(views[name]!())
  })

/** Structural document checks: persisted SDDs, drafts from files or stdin, and draft document sets. */
const documentCommand = (name: string): Handler =>
  report('DOCUMENT_CHECK_FAILED', async ({ value, has }) => {
    for (const policy of ['--document-policy', '--design-policy'])
      if (has(policy) && value(policy) !== 'current')
        throw new UsageError(`DOCUMENT_POLICY_INVALID:${policy}`)
    // The flag selects how strictly the document is read; without it an existing document that
    // never opted into the policy stays readable.
    const documentPolicy: DocumentPolicy = has('--document-policy') ? 'current' : 'legacy'
    const sdd = value('--sdd')
    if (name === 'validate-draft' && has('--documents-file')) {
      const file = value('--documents-file')
      if (!file || !sdd || !isAbsolute(sdd) || has('--draft-file'))
        throw Error('DRAFT_DOCUMENTS_ARGS_INVALID')
      const documents = readJson(file)
      if (!Array.isArray(documents)) throw Error('DRAFT_DOCUMENTS_ARRAY_REQUIRED')
      const entries = documents as { path?: unknown; content?: unknown }[]
      const roots = entries.filter(
        (entry) => entry && typeof entry.path === 'string' && resolve(entry.path) === resolve(sdd)
      )
      if (roots.length !== 1 || typeof roots[0]!.content !== 'string')
        throw Error('DRAFT_ROOT_REQUIRED')
      return byValidity(
        validateDraftText(
          roots[0]!.content as string,
          sdd,
          entries as { path: string; content: string }[],
          documentPolicy
        )
      )
    }
    if (name === 'validate-draft' && !sdd) {
      const draftFile = value('--draft-file')
      const text = draftFile
        ? readFileSync(draftFile, 'utf8')
        : await new Response(Bun.stdin).text()
      return byValidity(validateDraftText(text, draftFile ?? '<stdin>', [], documentPolicy))
    }
    if (!sdd) throw new UsageError(SDD_REQUIRED)
    return byValidity(
      name === 'validate'
        ? validateDocument(sdd, documentPolicy)
        : name === 'validate-draft'
          ? validateDraft(sdd, documentPolicy)
          : documentCheck(sdd)
    )
  })

/** `status --view` selects one read-only projection; `summary` is the default. */
const STATUS_VIEWS: Readonly<Record<string, string>> = {
  summary: 'status',
  resume: 'resume-view',
  runtime: 'runtime-view'
}

/**
 * `recover --kind` operations. Each keeps its own required inputs and authority checks; the
 * shared entry point only selects one, and option validation already rejected foreign flags.
 */
const RECOVERY: Readonly<Record<string, Handler>> = {
  lock: mutation('LOCK_RECOVER_FAILED', ({ need }) => {
    const [sdd, hash, stopped, authorized] = need(
      'LOCK_RECOVER_ARGS_REQUIRED: pass --sdd --expected-lock-hash --owner-stopped --user-authorized',
      '--sdd',
      '--expected-lock-hash',
      '--owner-stopped',
      '--user-authorized'
    )
    return ok(lockRecover(sdd!, hash!, stopped!, authorized!))
  }),
  transaction: mutation('TRANSACTION_RECOVER_FAILED', ({ need }) => {
    const [sdd, role, state, revision, stopped] = need(
      'TRANSACTION_RECOVER_ARGS_REQUIRED: pass --sdd --role --expected-state --expected-revision --all-previous-writers-stopped',
      '--sdd',
      '--role',
      '--expected-state',
      '--expected-revision',
      '--all-previous-writers-stopped'
    )
    return ok(transactionRecover(sdd!, role!, state!, revision!, stopped!))
  }),
  takeover: mutation('COORDINATOR_TAKEOVER_FAILED', ({ value, need }) => {
    const [sdd, state, revision, reason, authorized, stopped, nextId] = need(
      'COORDINATOR_TAKEOVER_ARGS_REQUIRED: pass --sdd --expected-state --expected-revision --reason --user-authorized --all-previous-writers-stopped --coordinator-agent-id',
      '--sdd',
      '--expected-state',
      '--expected-revision',
      '--reason',
      '--user-authorized',
      '--all-previous-writers-stopped',
      '--coordinator-agent-id'
    )
    const capabilityFile = mintCoordinatorCredential('SDD_LOOP_NEW_COORDINATOR_TOKEN')
    const receipt = value('--runtime-receipt-file')
    const result = coordinatorTakeover(
      sdd!,
      state!,
      revision!,
      reason!,
      authorized!,
      stopped!,
      nextId!,
      undefined,
      undefined,
      receipt ? readJson(receipt) : undefined,
      capabilityFile
    )
    return ok({ ...result, ...(capabilityFile ? { capabilityFile } : {}) })
  }),
  bootstrap: mutation('BOOTSTRAP_RECOVER_FAILED', ({ value, need }) => {
    const [sdd, state, revision, reason, stopped, nextId] = need(
      'BOOTSTRAP_RECOVER_ARGS_REQUIRED: pass --sdd --expected-state --expected-revision --reason --all-previous-writers-stopped --coordinator-agent-id',
      '--sdd',
      '--expected-state',
      '--expected-revision',
      '--reason',
      '--all-previous-writers-stopped',
      '--coordinator-agent-id'
    )
    const capabilityFile = mintCoordinatorCredential('SDD_LOOP_NEW_COORDINATOR_TOKEN')
    const receipt = value('--runtime-receipt-file')
    const result = bootstrapRecover(
      sdd!,
      state!,
      revision!,
      reason!,
      stopped!,
      nextId!,
      undefined,
      undefined,
      receipt ? readJson(receipt) : undefined,
      capabilityFile
    )
    return ok({ ...result, ...(capabilityFile ? { capabilityFile } : {}) })
  })
}

/** Composition root: every registered command and the controller it calls. */
export const HANDLERS: Readonly<Record<string, Handler>> = {
  configuration: report('CONFIGURATION_FAILED', () => ok(configuration())),
  capabilities: report('CAPABILITIES_FAILED', () => ok(capabilities())),
  'validate-draft': documentCommand('validate-draft'),
  'document-check': documentCommand('document-check'),
  validate: documentCommand('validate'),
  'document-next-id': report('DOCUMENT_NEXT_ID_FAILED', ({ need }) => {
    const [sdd, prefix] = need(
      'SDD_AND_PREFIX_REQUIRED: pass --sdd and --prefix',
      '--sdd',
      '--prefix'
    )
    return ok(nextDocumentId(sdd!, prefix!))
  }),
  status: report('STATUS_FAILED', (flags) =>
    view(STATUS_VIEWS[flags.value('--view') ?? 'summary'] ?? 'status').run(flags)
  ),
  'context-view': view('context-view'),
  'context-read': view('context-read'),
  'coordinator-brief': view('coordinator-brief'),
  audit: view('audit'),
  'agent-bootstrap': mutation('BOOTSTRAP_FAILED', ({ value, has, need }) => {
    if (has('--receipts-file')) {
      const receipts = value('--receipts-file')
      if (!receipts)
        throw new UsageError('BOOTSTRAP_RECEIPTS_REQUIRED: pass --receipts-file /absolute/path')
      if (!has('--expected-state')) return ok(validateBootstrapPayload(receipts))
      const [sdd, agentId, state, revision] = need(
        'BOOTSTRAP_ARGS_REQUIRED: pass --sdd --agent-id --receipts-file --expected-state --expected-revision',
        '--sdd',
        '--agent-id',
        '--expected-state',
        '--expected-revision'
      )
      return ok(agentBootstrap(sdd!, agentId!, receipts, state!, revision!))
    }
    const [sdd, agentId, state, revision] = need(
      'BOOTSTRAP_ARGS_REQUIRED: pass --sdd --agent-id --expected-state --expected-revision',
      '--sdd',
      '--agent-id',
      '--expected-state',
      '--expected-revision'
    )
    return ok(runBootstrapProcesses(sdd!, agentId!, state!, revision!, value('--prepared-id')))
  }),
  'prepare-record': mutation('PREPARE_RECORD_FAILED', ({ need }) => {
    const [sdd, agentId, preparedId, type, payload, state, revision] = need(
      'PREPARE_RECORD_ARGS_REQUIRED: pass --sdd --agent-id --prepared-id --type --payload-json --expected-state --expected-revision',
      '--sdd',
      '--agent-id',
      '--prepared-id',
      '--type',
      '--payload-json',
      '--expected-state',
      '--expected-revision'
    )
    return ok(
      prepareRecord(sdd!, agentId!, preparedId!, type!, JSON.parse(payload!), state!, revision!)
    )
  }),
  'worktree-view': report('WORKTREE_READ_FAILED', ({ value, has, all }) => {
    const workspace = value('--workspace')
    if (!workspace) throw new UsageError('WORKSPACE_REQUIRED: pass --workspace /absolute/path')
    const sdd = value('--sdd')
    if (has('--sdd') && (!sdd || sdd.startsWith('--'))) throw new Error('SDD_REQUIRED')
    const generated = all('--generated-path')
    return ok(
      sdd ? productSnapshot(sdd, workspace, generated) : snapshotWorktree(workspace, [], generated)
    )
  }),
  'operator-receipt-scaffold': report('RECEIPT_SCAFFOLD_FAILED', ({ value, need }) => {
    const [agentId, leaseId] = need(
      'RECEIPT_BINDING_REQUIRED: pass --agent-id and --lease-id',
      '--agent-id',
      '--lease-id'
    )
    return ok(scaffoldOperatorReceipt(agentId!, leaseId!, value('--type')))
  }),
  'operator-receipt-lint': mutation('RECEIPT_LINT_FAILED', ({ value, has }) => {
    const receipt = has('--receipt') ? value('--receipt') : value('--payload-file')
    if (!receipt)
      throw new UsageError('RECEIPT_REQUIRED: pass --receipt /absolute/path/to/receipt.json')
    return byValidity(lintOperatorReceipt(receipt, value('--type')))
  }),
  'operator-reconcile': mutation('OPERATOR_RECONCILE_FAILED', ({ need }) => {
    const [sdd, state, revision, leaseId, agentId, observation] = need(
      'OPERATOR_RECONCILE_ARGS_REQUIRED: pass --sdd --expected-state --expected-revision --lease-id --agent-id --observation-json',
      '--sdd',
      '--expected-state',
      '--expected-revision',
      '--lease-id',
      '--agent-id',
      '--observation-json'
    )
    return ok(
      operatorReconcile(sdd!, state!, revision!, leaseId!, agentId!, JSON.parse(observation!))
    )
  }),
  'pre-action': mutation('PRE_ACTION_FAILED', ({ value, all }) => {
    const required = (flag: string) => {
      const result = value(flag)
      if (!result) throw new Error(`PRE_ACTION_ARGUMENT_REQUIRED: ${flag}`)
      return result
    }
    const agent = required('--agent')
    return ok(
      preActionGate(
        {
          sdd: required('--sdd'),
          expectedState: required('--expected-state'),
          expectedRevision: required('--expected-revision'),
          agent,
          agentId: required('--agent-id'),
          leaseId: required('--lease-id'),
          actionKind: required('--action-kind'),
          affectedPackages: all('--affected-package'),
          commandClass: value('--command-class') ?? 'GENERAL',
          dependencyEffect: value('--dependency-effect') ?? 'NONE',
          planId: value('--plan-id')
        },
        undefined
      )
    )
  }),
  'coordinator-preflight': mutation('HOST_RECEIPT_INVALID', ({ value, has }) => {
    const receipt = has('--runtime-receipt')
      ? value('--runtime-receipt')
      : value('--runtime-receipt-file')
    if (!receipt)
      throw new UsageError('HOST_RECEIPT_REQUIRED: pass --runtime-receipt /absolute/path')
    return ok(hostReceipt(receipt))
  }),
  init: mutation('INIT_FAILED', ({ value, has }) => {
    const sdd = value('--sdd')
    if (!sdd) throw new UsageError(SDD_REQUIRED)
    return ok(
      initLoop(
        sdd,
        Number(value('--max-rounds') ?? 5),
        has('--credit-budget') ? Number(value('--credit-budget')) : undefined,
        (value('--credit-mode') ?? 'observe') as 'observe' | 'enforce'
      )
    )
  }),
  recover: mutation('RECOVER_FAILED', (flags) => {
    const kind = flags.value('--kind')
    const handler = kind === undefined ? undefined : RECOVERY[kind]
    if (!handler)
      throw new UsageError('RECOVER_KIND_REQUIRED: pass --kind lock|transaction|takeover|bootstrap')
    return handler.run(flags)
  }),
  'auth-bootstrap': mutation('AUTH_BOOTSTRAP_FAILED', ({ value, need }) => {
    const [sdd, state, revision, authorized] = need(
      'AUTH_BOOTSTRAP_ARGS_REQUIRED: pass --sdd --expected-state --expected-revision --user-authorized',
      '--sdd',
      '--expected-state',
      '--expected-revision',
      '--user-authorized'
    )
    const receipt = value('--runtime-receipt-file')
    const capabilityFile = mintCoordinatorCredential('SDD_LOOP_COORDINATOR_TOKEN')
    const result = authBootstrap(
      sdd!,
      state!,
      revision!,
      authorized!,
      undefined,
      value('--coordinator-agent-id'),
      receipt ? readJson(receipt) : undefined,
      capabilityFile
    )
    return ok({ ...result, ...(capabilityFile ? { capabilityFile } : {}) })
  }),
  'runtime-record': mutation('RUNTIME_RECORD_FAILED', ({ value, need }) => {
    const [sdd, role, revision, payloadFile] = need(
      'RUNTIME_RECORD_ARGS_REQUIRED: pass --sdd --role --expected-revision --payload-file',
      '--sdd',
      '--role',
      '--expected-revision',
      '--payload-file'
    )
    let payload: unknown
    try {
      payload = readJson(payloadFile!)
    } catch {
      throw new Error('RUNTIME_PAYLOAD_INVALID')
    }
    return ok(runtimeRecord(sdd!, role!, value('--expected-state'), revision!, payload))
  }),
  prepare: mutation('PREPARE_FAILED', ({ has, need }) => {
    const message =
      'PREPARE_ARGS_REQUIRED: pass --sdd --role --expected-state --expected-revision --agent-id and --fresh/--cancel'
    const [sdd, role, state, revision, agentId] = need(
      message,
      '--sdd',
      '--role',
      '--expected-state',
      '--expected-revision',
      '--agent-id'
    )
    const fresh = has('--fresh'),
      cancel = has('--cancel')
    if (!fresh && !cancel) throw new UsageError(message)
    return ok(prepare(sdd!, role!, state!, revision!, agentId!, fresh, cancel))
  }),
  record: mutation('RECORD_FAILED', ({ need }) => {
    const [sdd, role, state, revision, type, payloadJson] = need(
      'RECORD_ARGS_REQUIRED: pass --sdd --role --expected-state --expected-revision --type --payload-json',
      '--sdd',
      '--role',
      '--expected-state',
      '--expected-revision',
      '--type',
      '--payload-json'
    )
    let payload: unknown
    try {
      payload = JSON.parse(payloadJson!)
    } catch {
      throw new Error('PAYLOAD_JSON_INVALID')
    }
    return ok(recordEvent(sdd!, role!, state!, revision!, type!, payload))
  }),
  'agent-start-receipt': mutation('AGENT_START_RECEIPT_FAILED', ({ value, need }) => {
    const [sdd, agent, agentId, leaseId, readResult, summaryFile, state, revision] = need(
      'AGENT_START_RECEIPT_ARGS_REQUIRED: pass --sdd --agent --agent-id --lease-id --read-result --summary-file --expected-state --expected-revision',
      '--sdd',
      '--agent',
      '--agent-id',
      '--lease-id',
      '--read-result',
      '--summary-file',
      '--expected-state',
      '--expected-revision'
    )
    // Role-authored structured inputs stay structured; they are never folded into prose.
    const json = (flag: string): unknown => {
      const file = value(flag)
      if (!file) return undefined
      try {
        return readJson(file)
      } catch {
        throw new Error(`AGENT_START_INPUT_INVALID: ${flag}`)
      }
    }
    const supplement = json('--supplement') as Record<string, unknown> | undefined
    const goalAck = value('--goal-ack-file')
    return ok(
      agentStartReceipt(
        sdd!,
        agent! as 'operator' | 'architect',
        agentId!,
        leaseId!,
        readResult!,
        readFileSync(summaryFile!, 'utf8'),
        state!,
        revision!,
        undefined,
        goalAck ? readJson(goalAck) : undefined,
        {
          ...(value('--guidance-response')
            ? { guidanceResponse: json('--guidance-response') }
            : {}),
          ...(supplement ? { recoveryReadback: supplement.recovery_readback ?? supplement } : {})
        }
      )
    )
  }),
  'agent-record': mutation('AGENT_RECORD_FAILED', ({ value, need }) => {
    const message =
      'AGENT_RECORD_ARGS_REQUIRED: pass --sdd --agent --agent-id --lease-id --expected-state --expected-revision --type and payload'
    const [sdd, agent, agentId, leaseId, state, revision, type] = need(
      message,
      '--sdd',
      '--agent',
      '--agent-id',
      '--lease-id',
      '--expected-state',
      '--expected-revision',
      '--type'
    )
    const payloadJson = value('--payload-json'),
      payloadFile = value('--payload-file')
    if (!payloadJson && !payloadFile) throw new UsageError(message)
    const payload = JSON.parse(payloadFile ? readFileSync(payloadFile, 'utf8') : payloadJson!)
    return ok(
      agentRecord(
        sdd!,
        agent! as 'operator' | 'architect',
        agentId!,
        leaseId!,
        state!,
        revision!,
        type!,
        payload,
        undefined
      )
    )
  }),
  transition: mutation('TRANSITION_FAILED', ({ need }) => {
    const [sdd, role, state, revision, next] = need(
      'TRANSITION_ARGS_REQUIRED: pass --sdd --role --expected-state --expected-revision --to',
      '--sdd',
      '--role',
      '--expected-state',
      '--expected-revision',
      '--to'
    )
    return ok(transition(sdd!, role!, state!, revision!, next!))
  }),
  dispatch: mutation('DISPATCH_FAILED', ({ value, all, need }) => {
    const [sdd, role, state, revision, agent, agentId, scopeJson, workItem] = need(
      'DISPATCH_ARGS_REQUIRED: pass --sdd --role --expected-state --expected-revision --agent --agent-id --soft-deadline --hard-deadline --scope-json --work-item',
      '--sdd',
      '--role',
      '--expected-state',
      '--expected-revision',
      '--agent',
      '--agent-id',
      '--scope-json',
      '--work-item'
    )
    const scope = JSON.parse(scopeJson!) as unknown
    if (!Array.isArray(scope) || !scope.every((item) => typeof item === 'string'))
      throw new Error('DISPATCH_SCOPE_INVALID')
    const optional: Record<string, string | undefined> = {
      packet: value('--packet'),
      contextFingerprint: value('--context-fingerprint'),
      guidanceId: value('--guidance-id'),
      operatorGoal: value('--operator-goal'),
      goalUnavailableReason: value('--goal-unavailable-reason'),
      preparedId: value('--prepared-id'),
      operatorProfile: value('--operator-profile'),
      verificationMode: value('--verification-mode'),
      worktreeRoot: value('--worktree-root'),
      repairProbeRoot: value('--pipeline-repair-probe-root') ?? value('--repair-probe-root'),
      resumeCheckpoint: value('--resume-checkpoint'),
      correctionFindingId: value('--correction-finding-id'),
      freshReason: value('--fresh-reason'),
      verificationShard: value('--verification-shard')
    }
    const generatedPaths = all('--generated-path').filter(Boolean)
    const options = {
      ...Object.fromEntries(Object.entries(optional).filter(([, item]) => item)),
      ...(generatedPaths.length ? { generatedPaths } : {})
    } as DispatchOptions
    return ok(
      dispatch(
        sdd!,
        role!,
        state!,
        revision!,
        agent! as 'operator' | 'architect',
        agentId!,
        Number(value('--soft-deadline')),
        Number(value('--hard-deadline')),
        scope,
        workItem!,
        undefined,
        options
      )
    )
  }),
  attempt: mutation('ATTEMPT_FAILED', ({ need }) => {
    const [sdd, role, state, revision, progress] = need(
      'ATTEMPT_ARGS_REQUIRED: pass --sdd --role --expected-state --expected-revision --progress',
      '--sdd',
      '--role',
      '--expected-state',
      '--expected-revision',
      '--progress'
    )
    return ok(attempt(sdd!, role!, state!, revision!, progress!))
  }),
  'execution-failure': failureCommand('execution'),
  'pipeline-failure': failureCommand('pipeline'),
  'user-control': mutation('USER_CONTROL_FAILED', ({ value, need }) => {
    const [sdd, role, state, revision, action, reason, authorized] = need(
      'USER_CONTROL_ARGS_REQUIRED: pass --sdd --role --expected-state --expected-revision --action --reason --user-authorized',
      '--sdd',
      '--role',
      '--expected-state',
      '--expected-revision',
      '--action',
      '--reason',
      '--user-authorized'
    )
    const credit = value('--credit-amount')
    return ok(
      userControl(
        sdd!,
        role!,
        state!,
        revision!,
        action!,
        reason!,
        authorized!,
        value('--writer-stopped'),
        value('--checkpoint'),
        undefined,
        credit === undefined ? undefined : Number(credit)
      )
    )
  }),
  requirement: mutation('REQUIREMENT_FAILED', ({ value, need }) => {
    const [sdd, role, state, revision, id, requirementStatus] = need(
      'REQUIREMENT_ARGS_REQUIRED: pass --sdd --role --expected-state --expected-revision --id --status',
      '--sdd',
      '--role',
      '--expected-state',
      '--expected-revision',
      '--id',
      '--status'
    )
    return ok(
      requirementUpdate(
        sdd!,
        role!,
        state!,
        revision!,
        id!,
        requirementStatus!,
        value('--evidence'),
        value('--owner'),
        value('--trigger'),
        value('--impact'),
        value('--approved-by')
      )
    )
  }),
  finding: mutation('FINDING_FAILED', ({ value, need }) => {
    const [sdd, role, state, revision, id, priority, findingStatus] = need(
      'FINDING_ARGS_REQUIRED: pass --sdd --role --expected-state --expected-revision --id --priority --status',
      '--sdd',
      '--role',
      '--expected-state',
      '--expected-revision',
      '--id',
      '--priority',
      '--status'
    )
    return ok(
      findingUpdate(
        sdd!,
        role!,
        state!,
        revision!,
        id!,
        priority!,
        findingStatus!,
        value('--evidence')
      )
    )
  }),
  amend: mutation('AMEND_FAILED', ({ value, need }) => {
    const [sdd, role, state, revision, document, contractRevision, reason] = need(
      'AMEND_ARGS_REQUIRED: pass --sdd --role --expected-state --expected-revision --document --contract-revision --reason',
      '--sdd',
      '--role',
      '--expected-state',
      '--expected-revision',
      '--document',
      '--contract-revision',
      '--reason'
    )
    return ok(
      amendContract(
        sdd!,
        role!,
        state!,
        revision!,
        document!,
        contractRevision!,
        reason!,
        undefined,
        {
          scopeChangeAuthorized: value('--scope-change-authorized') === 'yes',
          scopeChangeReason: value('--scope-change-reason'),
          lineageCorrection: value('--lineage-correction') === 'yes'
        }
      )
    )
  }),
  'program-check': report('PROGRAM_CHECK_FAILED', ({ need }) => {
    const [program] = need('PROGRAM_REQUIRED', '--program')
    return ok(programCheck(program!))
  }),
  'workflow-status': report('PROGRAM_STATUS_FAILED', ({ value }) => {
    const program = value('--program'),
      run = value('--run')
    if ((!program && !run) || (program && run)) throw new Error('PROGRAM_LOCATION_REQUIRED')
    return ok(workflowStatus((program ?? run)!))
  }),
  ...Object.fromEntries(
    [
      ['program-start', programStart],
      ['program-next', programNext],
      ['program-record', programRecord],
      ['program-stop', (p: string, i: Record<string, unknown>) => programPause(p, i, true)],
      ['program-resume', (p: string, i: Record<string, unknown>) => programPause(p, i, false)],
      ['program-lock-recover', programRecoverLock]
    ].map(([name, operation]) => [
      name,
      mutation('PROGRAM_OPERATION_FAILED', ({ need, value }) => {
        const [payload] = need('PROGRAM_PAYLOAD_REQUIRED', '--payload-file')
        const program = value('--program'),
          run = value('--run')
        if (
          (!program && !run) ||
          (program && run) ||
          (run &&
            !['program-stop', 'program-resume', 'program-lock-recover'].includes(String(name)))
        )
          throw new Error('PROGRAM_LOCATION_REQUIRED')
        const input: unknown = JSON.parse(readFileSync(payload!, 'utf8'))
        if (!input || typeof input !== 'object' || Array.isArray(input))
          throw new Error('PROGRAM_PAYLOAD_INVALID')
        return ok(
          (operation as (p: string, i: Record<string, unknown>) => object)(
            (program ?? run)!,
            input as Record<string, unknown>
          )
        )
      })
    ])
  ),
  'test-run': mutation('TEST_RUN_FAILED', ({ value }) => {
    const sdd = value('--sdd'),
      agent = value('--agent'),
      agentId = value('--agent-id'),
      leaseId = value('--lease-id'),
      state = value('--expected-state'),
      revision = value('--expected-revision'),
      acceptance = value('--acceptance-ids'),
      commandJson = value('--command-json'),
      preset = value('--preset'),
      preparedId = value('--prepared-id')
    if (
      !sdd ||
      !agent ||
      !agentId ||
      (!leaseId && !preparedId) ||
      !state ||
      !revision ||
      !acceptance ||
      (!commandJson && !preset)
    )
      throw new UsageError(
        'TEST_RUN_ARGS_REQUIRED: pass --sdd --agent --agent-id (--lease-id or --prepared-id) --expected-state --expected-revision --acceptance-ids (--command-json and/or --preset) [--cwd]'
      )
    const extra: unknown = commandJson ? JSON.parse(commandJson) : []
    if (!Array.isArray(extra) || extra.some((part) => typeof part !== 'string'))
      throw new Error('TEST_RUN_COMMAND_REQUIRED')
    if (preset !== undefined && !Object.hasOwn(TEST_PRESETS, preset))
      throw new Error(`TEST_RUN_PRESET_UNKNOWN: ${Object.keys(TEST_PRESETS).join(',')}`)
    // A preset only prefixes argv; timing, bounds and recording stay in the controller.
    const argv = [...(preset ? TEST_PRESETS[preset]!.argv : []), ...(extra as string[])]
    if (!argv.length) throw new Error('TEST_RUN_COMMAND_REQUIRED')
    return ok(
      testRun(
        sdd,
        agent,
        agentId,
        leaseId ?? '',
        state,
        revision,
        acceptance.split(',').filter(Boolean),
        argv,
        value('--cwd'),
        undefined,
        undefined,
        preparedId
      )
    )
  }),
  'process-reclaim': report('PROCESS_RECLAIM_FAILED', ({ value }) => {
    const sdd = value('--sdd'),
      agentId = value('--agent-id')
    if (!sdd || !agentId) throw new Error('PROCESS_RECLAIM_ARGS_REQUIRED: pass --sdd --agent-id')
    return ok(processReclaim(sdd, agentId))
  }),
  retrospective: report('RETROSPECTIVE_FAILED', ({ value, has }) => {
    const sdd = value('--sdd')
    if (!sdd) throw new Error(SDD_REQUIRED)
    return ok(
      has('--write')
        ? { ...retrospective(sdd), written: writeRetrospective(sdd) }
        : retrospective(sdd)
    )
  }),
  'evolution-digest': report('EVOLUTION_DIGEST_FAILED', ({ value }) => {
    const files = value('--retrospective-files')
    if (!files) throw new Error('RETROSPECTIVE_FILES_REQUIRED: pass a comma-separated list')
    return ok(evolutionDigest(files.split(',').filter(Boolean)))
  }),
  'runtime-plan': report('RUNTIME_PLAN_FAILED', ({ value }) => {
    const sdd = value('--sdd')
    if (!sdd) throw new Error(SDD_REQUIRED)
    return ok(runtimePlan(sdd))
  })
}

function failureCommand(kind: 'execution' | 'pipeline'): Handler {
  return mutation('FAILURE_FAILED', ({ need }) => {
    const [sdd, role, state, revision, agent, reason, rootCause] = need(
      'FAILURE_ARGS_REQUIRED: pass --sdd --role --expected-state --expected-revision --agent --reason --root-cause-key',
      '--sdd',
      '--role',
      '--expected-state',
      '--expected-revision',
      '--agent',
      '--reason',
      '--root-cause-key'
    )
    return ok(failure(kind, sdd!, role!, state!, revision!, agent!, reason!, rootCause!))
  })
}
