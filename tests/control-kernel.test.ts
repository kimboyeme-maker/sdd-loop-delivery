import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eventLogBinding } from '../scripts/resource/store/event-log-binding'
import { rolePublicKey } from '../scripts/resource/role-signature'
import {
  assertCoordinatorToken,
  commitControl,
  loadControl,
  openCoordinatorCommand,
  signCoordinatorEvent
} from '../scripts/services/control-kernel'

type Item = Record<string, unknown>
const TOKEN = 'coordinator-capability'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

/** A minimal committed sidecar pair at a named phase, as `init` would leave it. */
function fixture(patch: Item = {}): { sdd: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'control-kernel-'))
  const sdd = join(root, 'feature.sdd.md')
  const events = Buffer.from('')
  const state: Item = {
    protocol: 'control-plane/state-v2',
    sdd,
    phase: 'CONTRACT_DRAFT',
    contract_revision: 'SDD-v1',
    revision: 5,
    authority_epoch: 1,
    active_lease: null,
    coordinator_token_hash: hash(TOKEN),
    event_log: eventLogBinding(events),
    ...patch
  }
  writeFileSync(sdd, '# Feature\n')
  writeFileSync(`${sdd}.loop.json`, JSON.stringify(state))
  writeFileSync(`${sdd}.events.jsonl`, events)
  return { sdd, root }
}

test('a command that has not been initialized is rejected before anything else is read', () => {
  const root = mkdtempSync(join(tmpdir(), 'control-kernel-'))
  try {
    expect(() => loadControl(join(root, 'absent.sdd.md'))).toThrow('LOOP_NOT_INITIALIZED')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the mutation prologue rejects in a fixed order and names the revision field it compared', () => {
  const { sdd, root } = fixture()
  try {
    expect(() => openCoordinatorCommand(sdd, TOKEN, 'DISCOVER', 'SDD-v1')).toThrow(
      'EXPECTED_STATE_MISMATCH'
    )
    // The control revision counter (5) is a different number from the contract revision, and
    // passing it is the mistake the message has to name, not just report as a mismatch.
    expect(() => openCoordinatorCommand(sdd, TOKEN, 'CONTRACT_DRAFT', '5')).toThrow(
      'EXPECTED_REVISION_MISMATCH: expected contract_revision SDD-v1'
    )
    // The credential is checked last, so a caller reasoning about a stale phase learns that first.
    expect(() => openCoordinatorCommand(sdd, 'wrong', 'CONTRACT_DRAFT', 'SDD-v1')).toThrow(
      'COORDINATOR_AUTH_INVALID'
    )
    expect(openCoordinatorCommand(sdd, TOKEN, 'CONTRACT_DRAFT', 'SDD-v1').state.phase).toBe(
      'CONTRACT_DRAFT'
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('coordinator authority is the token value, so it outlives the process that bootstrapped it', () => {
  const { sdd, root } = fixture()
  try {
    // Nothing in the snapshot identifies an agent or a session: a restarted Coordinator that
    // still holds the capability reopens its own command, which is what recovers a lost process.
    expect(() => assertCoordinatorToken(loadControl(sdd).state, TOKEN)).not.toThrow()
    const { sdd: fresh, root: freshRoot } = fixture({ coordinator_token_hash: undefined })
    try {
      expect(() => assertCoordinatorToken(loadControl(fresh).state, TOKEN)).toThrow(
        'COORDINATOR_AUTH_BOOTSTRAP_REQUIRED'
      )
    } finally {
      rmSync(freshRoot, { recursive: true, force: true })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('terminal phases are immutable, and only a reader may open one', () => {
  const { sdd, root } = fixture({ phase: 'SHIP' })
  try {
    expect(() => openCoordinatorCommand(sdd, TOKEN, 'SHIP', 'SDD-v1')).toThrow(
      'TERMINAL_STATE_IMMUTABLE'
    )
    // `amend` opens with mutable:false so it can reject terminal states with its own code.
    expect(
      openCoordinatorCommand(sdd, TOKEN, 'SHIP', 'SDD-v1', { mutable: false }).state.phase
    ).toBe('SHIP')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an event proof is refused unless the credential matches the epoch key, and commits are atomic', () => {
  const { sdd, root } = fixture({
    coordinator_event_keys: { '1': rolePublicKey(TOKEN) }
  })
  try {
    const control = openCoordinatorCommand(sdd, TOKEN, 'CONTRACT_DRAFT', 'SDD-v1')
    const body = { event_id: 'EVT-1', role: 'coordinator', type: 'note', payload: {} }
    const signed = signCoordinatorEvent(control.state, body, TOKEN)
    expect(JSON.parse(signed).coordinator_proof.signature_algorithm).toBe('ed25519-role-v1')
    // A credential that is not the epoch's registered key cannot produce a proof under it.
    expect(() => signCoordinatorEvent(control.state, body, 'other', { proof: true })).toThrow(
      'COORDINATOR_EVENT_KEY_BINDING_INVALID'
    )
    const next = { ...control.state, revision: 6 }
    commitControl(control, next, signed, TOKEN)
    expect(JSON.parse(readFileSync(`${sdd}.loop.json`, 'utf8')).revision).toBe(6)
    expect(readFileSync(`${sdd}.events.jsonl`, 'utf8')).toBe(signed)
    // The commit compared the bytes this command read, so replaying it now finds them changed.
    expect(() => commitControl(control, next, signed, TOKEN)).toThrow()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
