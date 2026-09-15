import { createHash } from 'node:crypto'
import { rolePublicKey, signRoleEvent, verifyRoleEvent } from './role-signature'
import type { JournalSecurity } from './store/sidecar-transaction'
type Item = Record<string, unknown>
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** Verify journal provenance using an already issued lease or preparation grant. */
export function verifyRoleTransaction(state: Item, bytes: Uint8Array, proof: string): boolean {
  try {
    const receipt = JSON.parse(proof) as Item
    if (receipt.protocol !== 'role-transaction/v1' || receipt.journal_sha256 !== digest(bytes))
      return false
    const grant =
      receipt.kind === 'lease'
        ? (state.issued_leases as Record<string, Item> | undefined)?.[String(receipt.grant_id)]
        : receipt.kind === 'preparation'
          ? (state.preparation as Item | undefined)
          : undefined
    if (
      !grant ||
      receipt.grant_id !== (receipt.kind === 'lease' ? grant.lease_id : grant.prepared_id) ||
      receipt.agent_id !== grant.agent_id ||
      receipt.authority_epoch !== grant.authority_epoch ||
      typeof grant.event_public_key !== 'string'
    )
      return false
    return verifyRoleEvent(receipt, grant.event_public_key)
  } catch {
    return false
  }
}

/** Sign transaction bytes with the role credential; never requires Coordinator signing authority. */
export function roleTransactionSecurity(state: Item, grant: Item, token: string): JournalSecurity {
  if (grant.event_public_key !== rolePublicKey(token)) throw Error('ROLE_TRANSACTION_KEY_MISMATCH')
  const kind = typeof grant.lease_id === 'string' ? 'lease' : 'preparation'
  const grantId = kind === 'lease' ? grant.lease_id : grant.prepared_id
  if (typeof grantId !== 'string' || !grantId) throw Error('ROLE_TRANSACTION_GRANT_REQUIRED')
  return {
    sign: (bytes) =>
      JSON.stringify(
        signRoleEvent(
          {
            protocol: 'role-transaction/v1',
            kind,
            grant_id: grantId,
            agent_id: grant.agent_id,
            authority_epoch: grant.authority_epoch,
            journal_sha256: digest(bytes)
          },
          token
        )
      ),
    verify: (bytes, proof) => verifyRoleTransaction(state, bytes, proof)
  }
}
