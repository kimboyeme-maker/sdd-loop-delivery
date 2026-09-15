import { Type, type Static } from 'typebox'
import { Compile } from 'typebox/compile'
import { isBeforeDeadline } from '../domain/policies/deadline'

/** Wire schemas belong at boundaries. No secret or cached auth decision is persisted. */
export const InvocationMetadataSchema = Type.Object(
  {
    protocol: Type.Literal('skill-invocation/v1'),
    invocation_id: Type.String({ minLength: 1 }),
    started_at: Type.String({ minLength: 1 }),
    origin: Type.Union([Type.Literal('explicit'), Type.Literal('implicit')])
  },
  { additionalProperties: false }
)
export type InvocationMetadata = Static<typeof InvocationMetadataSchema>
const metadataValidator = Compile(InvocationMetadataSchema)

/** These are descriptive fields, not a lease, identity proof, or capability. */
export type SkillRuntimeContext = Readonly<{
  invocation: Readonly<InvocationMetadata>
  sddPath: string
  controllerRelease: string
}>
export type CommandContext = Readonly<{
  skill: SkillRuntimeContext
  commandId: string
  now: () => number
}>

/**
 * Construct immutable metadata for callers that explicitly adopt this context.
 * Creating it does not authenticate an agent or automatically cover other CLI paths.
 */
export function createContext(input: unknown, sddPath: string, now: () => number): CommandContext {
  if (!metadataValidator.Check(input)) throw new Error('INVOCATION_METADATA_INVALID')
  if (!input.invocation_id.trim() || !Number.isFinite(Date.parse(input.started_at)))
    throw new Error('INVOCATION_METADATA_INVALID')
  const invocation = Object.freeze({ ...input })
  const skill = Object.freeze({ invocation, sddPath, controllerRelease: 'design-probe' })
  return Object.freeze({ skill, commandId: crypto.randomUUID(), now })
}

export type AuthoritySnapshot = Readonly<{
  epoch: number
  agentId: string
  leaseId: string
  deadline: number
  active: boolean
}>

/**
 * Check current authority, never an invocation's cached authorization.
 * The caller must protect this snapshot through the commit lock or optimistic comparison.
 */
export function assertCurrentLease(
  context: CommandContext,
  current: AuthoritySnapshot,
  submitted: Pick<AuthoritySnapshot, 'epoch' | 'agentId' | 'leaseId'>
): void {
  if (!current.active || !isBeforeDeadline(context.now(), current.deadline))
    throw new Error('LEASE_INACTIVE')
  if (
    !Number.isSafeInteger(current.epoch) ||
    current.epoch < 1 ||
    !current.agentId.trim() ||
    !current.leaseId.trim() ||
    current.epoch !== submitted.epoch ||
    current.agentId !== submitted.agentId ||
    current.leaseId !== submitted.leaseId
  ) {
    throw new Error('LEASE_BINDING_MISMATCH')
  }
}
