import { realpathSync, readFileSync } from 'node:fs'
import {
  readProgramBinding,
  readProgramRun,
  programGit,
  programHasCommit
} from '../resource/program-store'
import { readProgram, programHash, programDefinitionHash } from './program-contract'
import { canonicalJson } from '../resource/wire/canonical-json'

type Item = Record<string, unknown>

/** Shared program precondition for leases, writes, commands and candidate registration. */
export function assertProgramExecution(
  sdd: string,
  state: Item,
  packetId: unknown,
  mode: 'read' | 'dispatch' | 'write' | 'test' | 'implementation',
  worktree?: string
): Item | null {
  const binding = readProgramBinding(sdd)
  if (!binding && state.program_binding === undefined) return null
  if (!binding || canonicalJson(binding) !== canonicalJson(state.program_binding))
    throw new Error('PROGRAM_BINDING_MISMATCH')
  const run = readProgramRun(binding.state_path),
    slot = run.slots[binding.bundle_id]
  if (
    !slot ||
    slot.intent_id !== binding.intent_id ||
    slot.sdd !== realpathSync(sdd) ||
    !slot.worktree
  )
    throw new Error('PROGRAM_BINDING_MISMATCH')
  if (slot.creation_state !== 'BOUND') throw new Error('PROGRAM_BINDING_RECONCILIATION_REQUIRED')
  const d = readProgram(run.program),
    b = d.bundles.find((m) => m.id === binding.bundle_id)!
  if (
    slot.definition_hash !== programDefinitionHash(d, binding.bundle_id) ||
    programHash(readFileSync(sdd)) !== programHash(readFileSync(d.files[b.owner]!))
  )
    throw new Error('PROGRAM_CHILD_SOURCE_DIVERGED')
  if (worktree && realpathSync(worktree) !== slot.worktree)
    throw new Error('PROGRAM_WORKTREE_INVALID')
  if (programGit(slot.worktree, 'rev-parse', '--show-toplevel') !== slot.worktree)
    throw new Error('PROGRAM_WORKTREE_INVALID')
  const batches = d.contracts[b.owner]!.delivery_plan.batches
  const batch = packetId == null ? undefined : batches.find((x) => x.id === packetId)
  if (packetId != null && !batch) throw new Error('PROGRAM_BATCH_UNKNOWN')
  const missing = slot.required_commits.filter(
    (commit) => !programHasCommit(slot.worktree!, commit)
  )
  if (mode !== 'read') {
    if (slot.stopped || slot.release_commit) throw new Error('PROGRAM_CHILD_ALREADY_STOPPED')
    if (missing.length && (!slot.integration_batch_id || packetId !== slot.integration_batch_id))
      throw new Error('PROGRAM_INPUTS_NOT_IN_BASELINE')
    if (mode === 'implementation' && missing.length)
      throw new Error('PROGRAM_INPUTS_NOT_IN_BASELINE')
  }
  return {
    program: run.program,
    bundle_id: binding.bundle_id,
    intent_id: slot.intent_id,
    sdd: slot.sdd,
    packet_id: packetId ?? null,
    worktree: slot.worktree,
    definition_hash: slot.definition_hash,
    required_commits: slot.required_commits,
    integration_batch_id: slot.integration_batch_id ?? null,
    modification_packages: batch?.modification_packages ?? [
      ...new Set(batches.flatMap((x) => x.modification_packages))
    ],
    allowance_seconds: slot.allowance,
    stop_conditions: [
      'missing input permits only the declared integration batch',
      'test authorization is separate; timeout reservations never reset',
      'handoff precedes authorized commit; release binds the immutable commit'
    ]
  }
}

/** Read-only reports preserve diagnostics instead of blocking recovery on invalid bindings. */
export function programExecutionView(sdd: string, state: Item, packetId?: string): object | null {
  try {
    return assertProgramExecution(sdd, state, packetId, 'read')
  } catch (e) {
    return {
      executable: false,
      reason: e instanceof Error ? e.message : 'PROGRAM_BINDING_MISMATCH'
    }
  }
}
