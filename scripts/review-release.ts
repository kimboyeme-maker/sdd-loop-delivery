/** Aggregate automated checks only; host behavior and semantic parity require separate evidence. */
type ReleaseCheck = readonly [name: string, command: readonly string[]]

const checks: readonly ReleaseCheck[] = [
  ['tests', ['run', 'test', '--reporter=dot']],
  ['format', ['run', 'format:check']],
  ['lint', ['run', 'lint']],
  ['typecheck', ['run', 'typecheck']],
  ['command-coverage', ['scripts/check-command-coverage.ts']],
  ['import-boundaries', ['scripts/check-import-boundaries.ts']],
  ['command-options', ['scripts/check-command-options.ts']],
  ['cli-chain', ['scripts/check-cli-chain.ts']],
  ['configuration', ['scripts/render-configuration.ts', '--check']],
  ['error-catalog', ['scripts/render-error-catalog.ts', '--check']],
  ['behavior-cases', ['scripts/behavior-eval.ts', '--runs', '1']]
]
const results: Array<{ check: string; exitCode: number }> = []
for (const [check, command] of checks) {
  const argv =
    command[0] === 'run'
      ? [process.execPath, ...command]
      : [process.execPath, `${import.meta.dir}/../${command[0]}`, ...command.slice(1)]
  const result = Bun.spawnSync(argv, {
    stdout: 'pipe',
    stderr: 'pipe'
  })
  results.push({ check, exitCode: result.exitCode })
  if (result.exitCode !== 0) {
    // TypeScript and some checkers report diagnostics on stdout. Preserve both
    // channels on failure so the caller need not rerun just to discover why.
    if (result.stdout.length) console.error(result.stdout.toString())
    console.error(result.stderr.toString())
    console.error(JSON.stringify({ protocol: 'release-review/v1', valid: false, results }))
    process.exit(result.exitCode || 1)
  }
}
console.log(
  JSON.stringify({
    protocol: 'release-review/v1',
    valid: true,
    scope: 'automated-checks-only',
    doesNotProve: ['semantic-parity', 'host-agent-behavior', 'production-readiness'],
    checks: results
  })
)
