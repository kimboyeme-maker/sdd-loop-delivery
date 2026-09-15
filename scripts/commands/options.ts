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

/**
 * Commands that group several operations behind one selector. Each kind keeps its own strict
 * option set, so merging entry points never widens what one operation accepts; `fallback` is the
 * kind used when the selector is omitted.
 */
export const KIND_OPTIONS: Readonly<
  Record<
    string,
    Readonly<{
      selector: string
      fallback?: string
      kinds: Readonly<Record<string, readonly string[]>>
    }>
  >
> = {
  recover: {
    selector: '--kind',
    kinds: {
      lock: ['--sdd', '--expected-lock-hash', '--owner-stopped', '--user-authorized'],
      transaction: [
        '--sdd',
        '--role',
        '--expected-state',
        '--expected-revision',
        '--all-previous-writers-stopped'
      ],
      takeover: [
        '--sdd',
        '--expected-state',
        '--expected-revision',
        '--reason',
        '--user-authorized',
        '--all-previous-writers-stopped',
        '--coordinator-agent-id',
        '--runtime-receipt-file'
      ],
      bootstrap: [
        '--sdd',
        '--expected-state',
        '--expected-revision',
        '--reason',
        '--all-previous-writers-stopped',
        '--coordinator-agent-id',
        '--runtime-receipt-file'
      ]
    }
  },
  status: {
    selector: '--view',
    fallback: 'summary',
    kinds: { summary: ['--sdd', '--compact'], resume: ['--sdd'], runtime: ['--sdd'] }
  }
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
  const selection = KIND_OPTIONS[command]
  if (selection) {
    const index = args.indexOf(selection.selector)
    const kind = index >= 0 ? args[index + 1] : selection.fallback
    const flags = kind === undefined ? undefined : selection.kinds[kind]
    if (!flags)
      throw new Error(
        `CLI_OPTION_KIND_INVALID:${selection.selector} ${Object.keys(selection.kinds).join('|')}`
      )
    const foreign = [...supplied].find(
      (flag) => flag !== selection.selector && !flags.includes(flag)
    )
    if (foreign) throw new Error(`CLI_OPTION_UNKNOWN:${foreign}`)
  }
}

/** Render only accepted syntax; controller checks still decide required values and authority. */
export function commandFlags(command: string): string {
  const render = (flags: readonly string[]) =>
    flags.map((flag) => (SWITCHES.has(flag) ? flag : `${flag} <value>`)).join(' ')
  const selection = KIND_OPTIONS[command]
  if (!selection) return render(COMMAND_OPTIONS[command] ?? [])
  return Object.entries(selection.kinds)
    .map(([kind, flags]) => `${selection.selector} ${kind} ${render(flags)}`)
    .join(' | ')
}
