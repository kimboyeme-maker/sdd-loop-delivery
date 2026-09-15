import { readFileSync } from 'node:fs'
import { assertBootstrapReceipts, type BootstrapReceipt } from '../domain/policies/bootstrap'
import { parseBootstrapReceipt } from '../schemas/host'

/**
 * Validate caller-supplied receipt shape and stage order without writing state.
 * This function neither contacts the host nor proves process/model provenance;
 * the mutation command persists the supplied receipts inside its signed transaction.
 */
export function validateBootstrapPayload(path: string): Readonly<Record<string, unknown>> {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error('BOOTSTRAP_PAYLOAD_INVALID')
  }
  if (!Array.isArray(value)) throw new Error('BOOTSTRAP_PAYLOAD_ARRAY_REQUIRED')
  const receipts = value.map((item, index) => {
    try {
      return parseBootstrapReceipt(item) as BootstrapReceipt
    } catch {
      throw new Error(`BOOTSTRAP_RECEIPT_INVALID:${index}`)
    }
  })
  assertBootstrapReceipts(receipts)
  return {
    protocol: 'agent-bootstrap-preflight/v1',
    agentId: receipts[0]!.agentId,
    stages: receipts.map(({ stage, processId }) => ({ stage, processId })),
    persisted: false
  }
}
