/** Read one CLI flag without interpreting or defaulting its value. */
export function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

/** Reject ambiguous singleton options before selecting paths or initializing command context. */
export function assertUniqueFlags(command: string, args: readonly string[]): void {
  const repeated =
    command === 'dispatch'
      ? new Set(['--generated-path'])
      : command === 'worktree-view'
        ? new Set(['--generated-path'])
        : new Set<string>()
  const seen = new Set<string>()
  for (const arg of args) {
    if (!/^--[a-z][a-z0-9-]*$/.test(arg)) continue
    if (seen.has(arg) && !repeated.has(arg)) throw new Error(`CLI_OPTION_DUPLICATE:${arg}`)
    seen.add(arg)
  }
}
