export type CommandSpec = Readonly<{ name: string; mutation: boolean; description: string }>
type CommandTuple = readonly [name: string, mutation: boolean]

/** Single public command inventory. Controllers are added only after their use case is implemented. */
const COMMAND_TUPLES: readonly CommandTuple[] = [
  ['configuration', false],
  ['capabilities', false],
  ['validate-draft', false],
  ['document-check', false],
  ['document-next-id', false],
  ['validate', false],
  ['status', false],
  ['context-view', false],
  ['context-read', false],
  ['agent-bootstrap', true],
  ['prepare-record', true],
  ['worktree-view', false],
  ['operator-receipt-scaffold', false],
  ['operator-receipt-lint', false],
  ['operator-reconcile', true],
  ['resume-view', false],
  ['pre-action', false],
  ['audit', false],
  ['coordinator-preflight', false],
  ['init', true],
  ['lock-recover', true],
  ['coordinator-takeover', true],
  ['bootstrap-recover', true],
  ['auth-bootstrap', true],
  ['runtime-record', true],
  ['runtime-view', false],
  ['prepare', true],
  ['transaction-recover', true],
  ['record', true],
  ['agent-start-receipt', true],
  ['agent-record', true],
  ['transition', true],
  ['dispatch', true],
  ['attempt', true],
  ['execution-failure', true],
  ['pipeline-failure', true],
  ['user-control', true],
  ['requirement', true],
  ['finding', true],
  ['amend', true],
  ['coordinator-brief', false],
  ['program-status', false],
  ['test-run', true],
  ['process-reclaim', true],
  ['retrospective', false],
  ['evolution-digest', false],
  ['runtime-plan', false]
]
export const COMMANDS: readonly CommandSpec[] = COMMAND_TUPLES.map(([name, mutation]) => ({
  name,
  mutation,
  description: `Execute the ${name} control-plane operation with its native contract.`
}))

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((command) => command.name === name)
}
