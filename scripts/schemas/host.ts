import { isRuntimeIdentity } from '../helpers/runtime-identity'
import { Type, type Static } from 'typebox'
import { Compile } from 'typebox/compile'

export const HostSpawnReceiptSchema = Type.Object(
  {
    protocol: Type.Literal('host-spawn-receipt/v1'),
    agent_id: Type.String({ minLength: 1 }),
    runtime: Type.String({ minLength: 1 }),
    model: Type.String({ minLength: 1 }),
    reasoning_effort: Type.Optional(Type.String({ minLength: 1 })),
    isolation: Type.String({ minLength: 1 })
  },
  { additionalProperties: false }
)
export type HostSpawnReceipt = Static<typeof HostSpawnReceiptSchema>
const validator = Compile(HostSpawnReceiptSchema)

export function parseHostSpawnReceipt(input: unknown): HostSpawnReceipt {
  if (!validator.Check(input) || !isRuntimeIdentity(input.agent_id))
    throw new Error('HOST_RECEIPT_INVALID')
  return input as HostSpawnReceipt
}

export const BootstrapReceiptSchema = Type.Object(
  {
    stage: Type.Union([
      Type.Literal('OPEN'),
      Type.Literal('REAUTHENTICATE'),
      Type.Literal('READY')
    ]),
    agentId: Type.String({ minLength: 1 }),
    processId: Type.String({ minLength: 1 }),
    success: Type.Boolean()
  },
  { additionalProperties: false }
)
export type BootstrapReceiptInput = Static<typeof BootstrapReceiptSchema>
const bootstrapValidator = Compile(BootstrapReceiptSchema)

export function parseBootstrapReceipt(input: unknown): BootstrapReceiptInput {
  if (!bootstrapValidator.Check(input) || !isRuntimeIdentity(input.agentId))
    throw new Error('BOOTSTRAP_RECEIPT_INVALID')
  return input as BootstrapReceiptInput
}
