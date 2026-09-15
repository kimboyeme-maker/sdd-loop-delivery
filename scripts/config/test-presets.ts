/**
 * Named acceptance command prefixes per surface. `test-run --preset <name>` prepends the prefix to
 * `--command-json` arguments; the controller still times, bounds and records the full argv.
 * `hint` is guidance for the acceptance author, never an assertion the preset makes.
 */
export const TEST_PRESETS: Readonly<
  Record<string, Readonly<{ argv: readonly string[]; surfaces: readonly string[]; hint: string }>>
> = {
  'bun-test': { argv: ['bun', 'test'], surfaces: ['bun', 'node'], hint: 'pass file and -t filter' },
  'node-test': { argv: ['node', '--test'], surfaces: ['node'], hint: 'pass test files' },
  vitest: {
    argv: ['bunx', 'vitest', 'run'],
    surfaces: ['web', 'node'],
    hint: 'pass file and -t filter'
  },
  playwright: {
    argv: ['bunx', 'playwright', 'test'],
    surfaces: ['web'],
    hint: 'pass spec file, --project and --grep for one journey'
  },
  'playwright-axe': {
    argv: ['bunx', 'playwright', 'test', '--grep', '@a11y'],
    surfaces: ['web'],
    hint: 'specs tag accessibility checks @a11y and assert axe violations are empty'
  },
  lighthouse: {
    argv: ['bunx', '@lhci/cli', 'autorun'],
    surfaces: ['web'],
    hint: 'budgets live in lighthouserc; pass --collect.url for the declared routes'
  },
  'cargo-test': {
    argv: ['cargo', 'test'],
    surfaces: ['rust'],
    hint: 'pass -p crate and test filter'
  },
  'go-test': {
    argv: ['go', 'test', '-race'],
    surfaces: ['go'],
    hint: 'pass -run pattern and package path'
  },
  pytest: {
    argv: ['uv', 'run', 'pytest', '-q'],
    surfaces: ['pyproject'],
    hint: 'pass node ids; replace uv with the project manager in use'
  },
  'flutter-test': {
    argv: ['flutter', 'test'],
    surfaces: ['flutter'],
    hint: 'pass test file or integration_test file with -d device'
  },
  xcodebuild: {
    argv: ['xcodebuild', 'test'],
    surfaces: ['ios'],
    hint: 'pass -scheme, -destination and -only-testing'
  },
  gradle: {
    argv: ['./gradlew'],
    surfaces: ['android'],
    hint: 'pass testDebugUnitTest or connectedDebugAndroidTest with --tests'
  },
  hvigor: {
    argv: ['hvigorw'],
    surfaces: ['harmonyos'],
    hint: 'pass the project test task and module'
  },
  'miniprogram-automator': {
    argv: ['node'],
    surfaces: ['mini-program'],
    hint: 'pass the automator journey script path'
  }
}
