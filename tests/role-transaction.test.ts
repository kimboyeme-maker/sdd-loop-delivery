import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rolePublicKey } from '../scripts/resource/role-signature'
import {
  roleTransactionSecurity,
  verifyRoleTransaction
} from '../scripts/resource/role-transaction'
import { commitSidecar, recoverSidecar } from '../scripts/resource/store/sidecar-transaction'
import { bindEventLog, eventLogBinding } from '../scripts/resource/store/event-log-binding'

for (const stage of ['journal', 'events', 'state'] as const) {
  test(`role journal recovers after ${stage} without Coordinator signing authority`, () => {
    const root = mkdtempSync(join(tmpdir(), 'role-journal-'))
    try {
      const token = 'isolated-role-token'
      const grant = {
        lease_id: 'lease-one',
        agent_id: 'operator-one',
        authority_epoch: 1,
        event_public_key: rolePublicKey(token)
      }
      const state = { issued_leases: { 'lease-one': grant }, active_lease: grant }
      const files = {
        state: join(root, 'state'),
        events: join(root, 'events'),
        journal: join(root, 'journal'),
        lock: join(root, 'lock')
      }
      const before = Buffer.from(JSON.stringify(state))
      const after = Buffer.from(JSON.stringify({ ...state, active_lease: null }))
      writeFileSync(files.state, before)
      writeFileSync(files.events, '')
      expect(() =>
        commitSidecar(
          files,
          after,
          Buffer.from('signed-event\n'),
          roleTransactionSecurity(state, grant, token),
          { state: before },
          (current) => {
            if (current === stage) throw Error('interrupted')
          }
        )
      ).toThrow('interrupted')
      const current = JSON.parse(readFileSync(files.state, 'utf8'))
      const security = {
        sign: () => {
          throw Error('recovery must not sign')
        },
        verify: (bytes: Uint8Array, proof: string) => verifyRoleTransaction(current, bytes, proof)
      }
      const journal = readFileSync(files.journal, 'utf8')
      const forged = JSON.parse(journal)
      const proof = JSON.parse(forged.proof)
      proof.agent_id = 'other-agent'
      forged.proof = JSON.stringify(proof)
      writeFileSync(files.journal, JSON.stringify(forged))
      const currentBytes = readFileSync(files.state)
      const currentEvents = readFileSync(files.events)
      expect(() => recoverSidecar(files, security)).toThrow(
        'CONTROL_TRANSACTION_JOURNAL_SIGNATURE_INVALID'
      )
      expect(readFileSync(files.state)).toEqual(currentBytes)
      expect(readFileSync(files.events)).toEqual(currentEvents)
      writeFileSync(files.journal, journal)
      expect(recoverSidecar(files, security)).toBe('recovered')
      // The committed state carries the binding of the events written with it.
      expect(readFileSync(files.state, 'utf8')).toBe(
        bindEventLog(after, eventLogBinding(Buffer.from('signed-event\n'))).toString('utf8')
      )
      expect(readFileSync(files.events, 'utf8')).toBe('signed-event\n')
      expect(recoverSidecar(files, security)).toBe('nothing-pending')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}
