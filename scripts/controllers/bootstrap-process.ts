import { parseEvents } from '../resource/store/event-log'
import { bootstrapReceiptFor, findLeaseByAgent } from '../helpers/lease-slots'
import { roleCapabilityToken } from '../resource/role-capability'
import { currentAdmission } from '../helpers/admission-authority'
import { prepareRecord } from './prepare-record.controller'
import { preparationBootstrapCount } from '../helpers/preparation-bootstrap'
import { assertActiveLease } from '../domain/policies/active-lease'
import { assertCurrentSource } from '../helpers/source-binding'
import { spawnSync } from 'node:child_process'
import { readSnapshot } from '../resource/state'
import { agentBootstrap } from './agent-bootstrap.controller'
import { assertBootstrapEvidence } from '../helpers/bootstrap-evidence'

const phases = ['OPEN', 'REAUTHENTICATE', 'READY'] as const

/** Each child reopens state and authenticates before persisting exactly one phase. */
export function runBootstrapProcesses(
  sdd: string,
  agentId: string,
  expectedState: string,
  expectedRevision: string,
  preparedId?: string
) {
  const eventIds: string[] = []
  for (let index = 0; index <= phases.length; index++) {
    const snapshot = readSnapshot(sdd)
    const state = snapshot.state
    const lease = (
      preparedId ? state.preparation : findLeaseByAgent(state as Record<string, unknown>, agentId)
    ) as Record<string, unknown> | null | undefined
    if (!lease || lease.agent_id !== agentId) throw new Error('BOOTSTRAP_ACTIVE_LEASE_REQUIRED')
    if (state.phase !== expectedState || state.contract_revision !== expectedRevision)
      throw new Error('BOOTSTRAP_ASSIGNMENT_CHANGED')
    if (preparedId) {
      if (
        lease.prepared_id !== preparedId ||
        lease.authority_epoch !== state.authority_epoch ||
        lease.contract_revision !== state.contract_revision
      )
        throw new Error('PREPARATION_GRANT_INVALID')
    } else assertActiveLease(state, lease)
    assertCurrentSource(state, sdd)
    let token: string
    try {
      token = roleCapabilityToken(lease)
    } catch {
      throw new Error('BOOTSTRAP_AGENT_AUTH_INVALID')
    }
    const coordinator = process.env.SDD_LOOP_COORDINATOR_TOKEN
    if (preparedId) {
      if (['PAUSED', 'CANCELLED', 'SHIP', 'BLOCKED'].includes(String(state.phase)))
        throw new Error('PREPARATION_STATE_INVALID')
      const events = parseEvents(snapshot.eventText)
      if (lease.admission_event_id !== currentAdmission(state, events, coordinator).event_id)
        throw new Error('PREPARATION_ADMISSION_STALE')
    }
    const prior = bootstrapReceiptFor(state as Record<string, unknown>, lease.lease_id)
    let count = 0
    if (preparedId) count = preparationBootstrapCount(state, lease, parseEvents(snapshot.eventText))
    else if (prior && prior.lease_id === lease.lease_id) {
      assertBootstrapEvidence(
        state,
        lease,
        parseEvents(snapshot.eventText),
        token,
        undefined,
        false
      )
      count = (prior.event_ids as unknown[]).length
    }
    if (count === phases.length)
      return { protocol: 'agent-bootstrap/v1', eventIds, agentStarted: false }
    const child = spawnSync(
      process.execPath,
      [
        import.meta.path,
        sdd,
        agentId,
        expectedState,
        expectedRevision,
        phases[count]!,
        ...(preparedId ? [preparedId] : [])
      ],
      { encoding: 'utf8', timeout: 30_000, env: process.env }
    )
    // A timeout may follow a durable commit. Never retry here; the next invocation
    // checks persisted evidence before choosing a missing phase.
    if (child.error || child.status !== 0)
      throw new Error(`BOOTSTRAP_PHASE_FAILED:${phases[count]}`)
    const result = JSON.parse(child.stdout)
    eventIds.push(...result.eventIds)
    if (lease.repair_probe_root && count === 2)
      return { protocol: 'agent-bootstrap/v1', eventIds, agentStarted: false }
  }
  throw new Error('BOOTSTRAP_SEQUENCE_DID_NOT_CONVERGE')
}

if (import.meta.main) {
  const [sdd, agentId, state, revision, phase, preparedId] = process.argv.slice(2)
  if (!sdd || !agentId || !state || !revision || !phases.includes(phase as (typeof phases)[number]))
    throw new Error('BOOTSTRAP_ARGS_INVALID')
  console.log(
    JSON.stringify(
      preparedId
        ? {
            eventIds: [
              prepareRecord(
                sdd,
                agentId,
                preparedId,
                'capability_probe',
                { phase },
                state,
                revision
              ).eventId
            ]
          }
        : agentBootstrap(
            sdd,
            agentId,
            [
              {
                stage: phase as (typeof phases)[number],
                agentId,
                processId: String(process.pid),
                success: true
              }
            ],
            state,
            revision,
            undefined,
            undefined,
            true
          )
    )
  )
}
