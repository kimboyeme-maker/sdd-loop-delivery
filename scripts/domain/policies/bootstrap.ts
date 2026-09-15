export type BootstrapReceipt = Readonly<{
  stage: 'OPEN' | 'REAUTHENTICATE' | 'READY'
  agentId: string
  processId: string
  success: boolean
}>

/** Validate the three real host-authentication observations without inventing identity. */
export function assertBootstrapReceipts(receipts: readonly BootstrapReceipt[]): void {
  if (receipts.length !== 3) throw new Error('BOOTSTRAP_STAGES_REQUIRED')
  const expected = ['OPEN', 'REAUTHENTICATE', 'READY'] as const
  for (const [index, receipt] of receipts.entries()) {
    if (receipt.stage !== expected[index]) throw new Error('BOOTSTRAP_STAGE_ORDER_INVALID')
    if (!receipt.agentId || !receipt.processId) throw new Error('BOOTSTRAP_IDENTITY_REQUIRED')
    if (!receipt.success) throw new Error('BOOTSTRAP_STAGE_FAILED')
  }
  const agentIds = new Set(receipts.map((receipt) => receipt.agentId))
  if (agentIds.size !== 1) throw new Error('BOOTSTRAP_AGENT_MISMATCH')
  const processIds = new Set(receipts.map((receipt) => receipt.processId))
  if (processIds.size !== receipts.length) throw new Error('BOOTSTRAP_PROCESS_NOT_DISTINCT')
}
