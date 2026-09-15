import { createHash } from 'node:crypto'
import { programGit, type ProgramHandoff } from '../resource/program-store'
import { loadControl, assertExecutableControl } from './control-kernel'
import { assertAuthenticCurrentEpoch } from './event-authentication'
import { currentCandidate, assertCandidateBinding } from '../helpers/candidate-evidence'
import { assertVerificationReviewer } from '../helpers/verification-reviewer'
import { leaseSnapshot } from '../helpers/worktree-candidate'
import { leaseSlots } from '../helpers/lease-slots'
import { programHash, type ProgramDocument } from './program-contract'

type Item = Record<string, unknown>

/** All role slots, including read-only preparations/shards, must be quiescent before release. */
export function programChildQuiescent(state: Item): boolean {
  return leaseSlots(state).length === 0 && !state.preparation && !state.pending_transaction
}

/** Byte/history projection survives the authorized commit's HEAD/index change. */
export function programProjection(
  sdd: string
): Pick<ProgramHandoff, 'product_hash' | 'event_hash'> {
  const c = loadControl(sdd),
    events = c.events()
  const event = events.filter((e) => e.type === 'implementation').at(-1)
  const actor = event?.actor as Item | undefined
  const lease = actor && (c.state.issued_leases as Record<string, Item>)[String(actor.lease_id)]
  const snapshot = lease && leaseSnapshot(sdd, lease)
  if (!snapshot) throw new Error('PROGRAM_HANDOFF_SNAPSHOT_REQUIRED')
  return {
    product_hash: programHash(JSON.stringify({ files: snapshot.files, owners: snapshot.owners })),
    event_hash: programHash(JSON.stringify(events))
  }
}

/** Validate exact accepted evidence before commit; no acceptance commands are executed. */
export function captureProgramHandoff(
  d: ProgramDocument,
  owner: string,
  sdd: string
): ProgramHandoff {
  const c = loadControl(sdd),
    events = c.events()
  assertExecutableControl(sdd, c)
  assertAuthenticCurrentEpoch(c.state, events)
  if (c.state.phase !== 'SHIP') throw new Error('PROGRAM_CHILD_NOT_SHIPPED')
  if (!programChildQuiescent(c.state)) throw new Error('PROGRAM_CHILD_MUST_BE_QUIESCENT')
  const { candidate, event: implementation } = currentCandidate(sdd, c.state, events)
  const implementationIndex = events.indexOf(implementation)
  const needed = new Set(
    d.program.metas
      .filter(
        (m) =>
          m.validators.implementation.owner === owner &&
          (m.kind === 'Asset' || m.kind === 'Entry' || m.kind === 'Bundle')
      )
      .flatMap((m) => m.validators.implementation.acceptance_ids)
  )
  const acceptanceEvents: Record<string, string> = {}
  for (const id of needed) {
    const acceptance = d.contracts[owner]!.acceptance.find((a) => a.id === id)
    const requirements = d.contracts[owner]!.requirements.filter(
      (r) =>
        r.kind !== 'non-goal' &&
        r.acceptance?.includes(id) &&
        acceptance?.requirement_ids?.includes(r.id)
    )
    if (
      !requirements.length ||
      requirements.some((r) => (c.state.requirements as Item)[r.id] !== 'verified')
    )
      throw new Error(`PROGRAM_ACCEPTANCE_UNVERIFIED: ${id}`)
    const verification = events.findLast((e, index) => {
      const p = e.payload as Item | undefined
      return (
        index > implementationIndex &&
        e.type === 'verification' &&
        e.contract_revision === c.state.contract_revision &&
        p?.result === 'PASS' &&
        Array.isArray(p.acceptance_ids) &&
        p.acceptance_ids.includes(id) &&
        Array.isArray(p.requirement_ids) &&
        requirements.every((r) => (p.requirement_ids as string[]).includes(r.id))
      )
    })
    if (!verification) throw new Error(`PROGRAM_ACCEPTANCE_UNVERIFIED: ${id}`)
    assertVerificationReviewer(c.state, events, verification)
    assertCandidateBinding(verification.payload as Item, candidate)
    if ((verification.actor as Item).agent_id === (implementation.actor as Item).agent_id)
      throw new Error('PROGRAM_REVIEWER_NOT_INDEPENDENT')
    if (
      events
        .slice(events.indexOf(verification) + 1)
        .some((e) =>
          [
            'verification_revoked',
            'amend',
            'contract_amendment',
            'timeout_decision',
            'pipeline_incident'
          ].includes(String(e.type))
        )
    )
      throw new Error('PROGRAM_ACCEPTANCE_REVOKED')
    const checks = (verification.payload as Item).checks
    if (
      !Array.isArray(checks) ||
      !checks.some(
        (check: Item) => Array.isArray(check.acceptance_ids) && check.acceptance_ids.includes(id)
      )
    )
      throw new Error(`PROGRAM_ACCEPTANCE_UNVERIFIED: ${id}`)
    acceptanceEvents[id] = String(verification.event_id)
  }
  const lease = (c.state.issued_leases as Record<string, Item>)[
    String((implementation.actor as Item).lease_id)
  ]!
  const snapshot = leaseSnapshot(sdd, lease)!
  const assets: NonNullable<ProgramHandoff['assets']> = {}
  for (const meta of d.program.metas.filter((m) => m.kind === 'Asset' && m.owner === owner)) {
    const files = snapshot.files.filter(
      (f) => f.kind !== 'missing' && (f.path === meta.path || f.path.startsWith(`${meta.path}/`))
    )
    if (!files.length || files.some((f) => !['file', 'symlink'].includes(f.kind)))
      throw new Error(`PROGRAM_ASSET_CONTENT_REQUIRED: ${meta.id}`)
    assets[meta.id] = {
      path: meta.path!,
      files: files.map((f) => ({
        path: f.path,
        mode: f.kind === 'symlink' ? '120000' : f.mode & 0o111 ? '100755' : '100644',
        sha256: f.sha256
      }))
    }
  }
  return {
    ...programProjection(sdd),
    contract_revision: String(c.state.contract_revision),
    candidate_id: String(candidate.candidate_id),
    acceptance_events: acceptanceEvents,
    assets
  }
}

/** Verify committed tree bytes, not merely paths. Raw blobs preserve binary bytes/newlines. */
export function assertCommittedAssets(
  worktree: string,
  commit: string,
  handoff: ProgramHandoff
): void {
  if (!handoff.assets || !handoff.acceptance_events || !handoff.candidate_id)
    throw new Error('PROGRAM_HANDOFF_RECONCILIATION_REQUIRED')
  for (const asset of Object.values(handoff.assets)) {
    const entries = programGit(worktree, 'ls-tree', '-r', '-z', commit)
      .split('\0')
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf('\t'),
          header = line.slice(0, tab),
          path = line.slice(tab + 1)
        const [mode, kind, object] = header.split(' ')
        return { mode: mode!, kind, object, path }
      })
      .filter((entry) => entry.path === asset.path || entry.path.startsWith(`${asset.path}/`))
      .map(({ mode, kind, object, path }) => {
        if (kind !== 'blob') throw new Error('PROGRAM_ASSET_CONTENT_REQUIRED')
        const result = Bun.spawnSync(['git', '-C', worktree, 'cat-file', 'blob', object!], {
          stdout: 'pipe',
          stderr: 'pipe'
        })
        if (result.exitCode !== 0) throw new Error('PROGRAM_ASSET_COMMIT_UNREADABLE')
        return {
          path: path!,
          mode: mode!,
          sha256: createHash('sha256').update(result.stdout).digest('hex')
        }
      })
    const sort = (items: typeof entries) => [...items].sort((a, b) => a.path.localeCompare(b.path))
    if (JSON.stringify(sort(entries)) !== JSON.stringify(sort(asset.files)))
      throw new Error(`PROGRAM_ASSET_COMMIT_MISMATCH: ${asset.path}`)
  }
}
