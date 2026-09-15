import inventory from './options.json'

/** Native command options shared by help and input validation; no historical catalog is loaded. */
export const COMMAND_OPTIONS: Readonly<Record<string, readonly string[]>> = inventory
const SWITCHES = new Set(['--compact', '--fresh', '--cancel', '--retained-understanding'])
/** Alternative spellings/sources select one input, never a precedence-based merge. */
const EXCLUSIVE: Readonly<Record<string, readonly string[]>> = {
  'context-read': ['--limit', '--max-bytes'],
  'validate-draft': ['--sdd', '--draft-file'],
  'operator-receipt-lint': ['--receipt', '--payload-file'],
  'coordinator-preflight': ['--runtime-receipt', '--runtime-receipt-file'],
  'agent-record': ['--payload-json', '--payload-file'],
  dispatch: ['--pipeline-repair-probe-root', '--repair-probe-root'],
  prepare: ['--fresh', '--cancel']
}

/** Reject unknown, misplaced or valueless options before any command can select a file. */
export function assertCommandOptions(command: string, args: readonly string[]): void {
  const allowed = COMMAND_OPTIONS[command]
  if (!allowed) throw new Error('CLI_COMMAND_OPTIONS_MISSING')
  const supplied = new Set<string>()
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!
    if (!allowed.includes(flag)) throw new Error(`CLI_OPTION_UNKNOWN:${flag}`)
    supplied.add(flag)
    if (SWITCHES.has(flag)) continue
    const value = args[++index]
    if (value === undefined || value.startsWith('--'))
      throw new Error(`CLI_OPTION_VALUE_REQUIRED:${flag}`)
  }
  const conflict = (EXCLUSIVE[command] ?? []).filter((flag) => supplied.has(flag))
  if (conflict.length > 1) throw new Error(`CLI_OPTIONS_MUTUALLY_EXCLUSIVE:${conflict.join(',')}`)
}

/** Render only accepted syntax; controller checks still decide required values and authority. */
export function commandFlags(command: string): string {
  return (COMMAND_OPTIONS[command] ?? [])
    .map((flag) => (SWITCHES.has(flag) ? flag : `${flag} <value>`))
    .join(' ')
}
