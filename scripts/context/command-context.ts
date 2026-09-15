import { createContext, type CommandContext } from './context'

/** Process-local metadata: one CLI process handles one command and holds no cached authority. */
let current: CommandContext | undefined

/** Initialize once at CLI ingress; direct library callers need not adopt this context. */
export function initializeCommandContext(
  metadata: string | undefined,
  sddPath: string
): CommandContext {
  if (current) throw new Error('COMMAND_CONTEXT_ALREADY_INITIALIZED')
  let input: unknown
  if (metadata !== undefined) {
    try {
      input = JSON.parse(metadata)
    } catch {
      throw new Error('INVOCATION_METADATA_INVALID')
    }
  } else
    input = {
      protocol: 'skill-invocation/v1',
      invocation_id: crypto.randomUUID(),
      started_at: new Date().toISOString(),
      origin: 'implicit'
    }
  current = createContext(input, sddPath, Date.now)
  return current
}

/** Return only correlation IDs; never expose the clock, paths or authorization through event metadata. */
export function commandCorrelation():
  | Readonly<{ invocation_id: string; command_id: string }>
  | undefined {
  return current
    ? { invocation_id: current.skill.invocation.invocation_id, command_id: current.commandId }
    : undefined
}

/** Attach process correlation before signing; direct library calls keep their original event shape. */
export function correlateEvent<T extends Record<string, unknown>>(
  body: T
): T & { context?: ReturnType<typeof commandCorrelation> } {
  const context = commandCorrelation()
  return context ? { ...body, context } : body
}
