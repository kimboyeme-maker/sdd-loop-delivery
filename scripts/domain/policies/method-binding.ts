/**
 * An acceptance `method` is a command line the contract declares; `test-run` receives an argv
 * vector. Nothing else connects them, so without this check a role may submit any argv and the
 * verification record will still report the contract's method, because later gates read the method
 * from the contract rather than from what ran. The usual way to get this wrong is silent and green:
 * splitting a piped method into naive argv hands the extra words to a test runner as file filters,
 * which matches nothing and exits 0.
 */

/** The exact argv forms a declared method may take. */
const SHELLS = ['sh', 'bash', 'zsh', '/bin/sh', '/bin/bash', '/bin/zsh']

/**
 * Whether this argv can only have come from running `method`. Two forms are accepted: the method
 * handed verbatim to a shell (`sh -c <method>`), and a method with no shell syntax split on single
 * spaces. Anything else is refused rather than guessed at — a heuristic that tries to re-derive
 * intent from a mangled command line would reintroduce exactly the silence this check exists to
 * remove.
 */
export function argvMatchesMethod(argv: readonly string[], method: string): boolean {
  const declared = method.trim()
  if (!declared) return false
  if (argv.length === 3 && SHELLS.includes(argv[0]!) && argv[1] === '-c')
    return argv[2]!.trim() === declared
  // A plain command may be split on spaces only when the method carries no shell syntax at all;
  // quoting, pipes, redirects and substitutions all change meaning under a naive split.
  if (/["'|&;<>$`\\]/.test(declared)) return false
  return argv.join(' ') === declared.split(/\s+/).join(' ')
}

/** Every acceptance this run claims to observe must be reachable by the argv that actually ran. */
export function assertMethodBinding(
  argv: readonly string[],
  acceptance: readonly Readonly<{ id: string; method?: unknown }>[]
): void {
  for (const item of acceptance) {
    if (typeof item.method !== 'string' || !item.method.trim())
      throw new Error(`TEST_RUN_METHOD_UNDECLARED: ${item.id}`)
    if (!argvMatchesMethod(argv, item.method))
      throw new Error(
        `TEST_RUN_METHOD_MISMATCH: ${item.id} (run the declared method verbatim, e.g. sh -c "<method>")`
      )
  }
}
