import { verifyRoleTransaction } from '../resource/role-transaction'
import { verifyCoordinatorTransaction } from '../resource/coordinator-evidence'
import { createHmac } from 'node:crypto'
import { sidecarPaths } from '../resource/state'
import { recoverSidecar } from '../resource/store/sidecar-transaction'
import { COORDINATOR_TOKEN_ENV, authenticateRecovery } from '../services/control-kernel'

/** Recover one prepared sidecar journal after host stop evidence; never re-runs a command. */
export function transactionRecover(
  sdd: string,
  role: string,
  expectedState: string,
  expectedRevision: string,
  previousWritersStopped: string,
  token = process.env[COORDINATOR_TOKEN_ENV]
): Readonly<{ protocol: 'transaction-recover/v1'; status: 'recovered' | 'nothing-pending' }> {
  if (role !== 'coordinator') throw new Error('TRANSACTION_RECOVER_COORDINATOR_ONLY')
  if (previousWritersStopped !== 'yes')
    throw new Error('PREVIOUS_WRITERS_STOP_CONFIRMATION_REQUIRED')
  if (!token) throw new Error('COORDINATOR_AUTH_REQUIRED')
  const paths = sidecarPaths(sdd)
  // The journal blocks the normal kernel path, so recovery authenticates from raw state.
  const { state } = authenticateRecovery(paths, token, {
    beforeAuthentication: (current) => {
      if (String(current.phase ?? '') !== expectedState) throw new Error('EXPECTED_STATE_MISMATCH')
      if (String(current.contract_revision ?? '') !== expectedRevision)
        throw new Error('EXPECTED_REVISION_MISMATCH')
    }
  })
  const security = {
    sign: (bytes: Uint8Array) => createHmac('sha256', token).update(bytes).digest('hex'),
    verify: (bytes: Uint8Array, proof: string) =>
      createHmac('sha256', token).update(bytes).digest('hex') === proof ||
      verifyCoordinatorTransaction(state, bytes, proof) ||
      verifyRoleTransaction(state, bytes, proof)
  }
  return { protocol: 'transaction-recover/v1', status: recoverSidecar(paths, security) }
}
