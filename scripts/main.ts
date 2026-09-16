#!/usr/bin/env bun
import { COMMANDS, findCommand } from './commands/registry'
import { HANDLERS, UsageError, flagsOf } from './commands/handlers'
import { recordRejection } from './services/retrospective'
import { assertUniqueFlags, flagValue } from './helpers/flag'
import { assertCommandOptions, commandFlags } from './commands/options'
import { initializeCommandContext } from './context/command-context'
import { COORDINATOR_TOKEN_FILE_ENV, readCapabilityFile } from './resource/role-capability'

/** CLI entry: validate the invocation, then run the command's handler from the composition root. */
const args = Bun.argv.slice(2)
if ((args.length === 1 && args[0] === '--help') || args.length === 0) {
  console.log('sdd-loop-delivery: use a command from the admitted controller contract')
  for (const command of COMMANDS)
    console.log(`${command.name}${command.mutation ? ' (mutation)' : ' (read-only)'}`)
  process.exit(0)
}
const command = findCommand(args[0]!)
if (!command) {
  console.error('COMMAND_UNKNOWN: consult --help')
  process.exit(2)
}
try {
  assertUniqueFlags(command.name, args.slice(1))
} catch (error) {
  console.error(error instanceof Error ? error.message : 'CLI_OPTIONS_INVALID')
  process.exit(2)
}
if (args.slice(1).includes('--help')) {
  console.log(`sdd-loop-delivery ${command.name}: ${command.description}`)
  console.log(`options: ${commandFlags(command.name)}`)
  process.exit(0)
}
try {
  assertCommandOptions(command.name, args.slice(1))
} catch (error) {
  console.error(error instanceof Error ? error.message : 'CLI_OPTIONS_INVALID')
  process.exit(2)
}
try {
  initializeCommandContext(process.env.SDD_INVOCATION_METADATA, flagValue(args, '--sdd') ?? '')
} catch (error) {
  console.error(error instanceof Error ? error.message : 'INVOCATION_METADATA_INVALID')
  process.exit(2)
}
// The Coordinator authenticates from its persistent private file; after context compaction
// it reloads the locator from raw state instead of rotating authority.
if (!process.env.SDD_LOOP_COORDINATOR_TOKEN && process.env[COORDINATOR_TOKEN_FILE_ENV]) {
  try {
    process.env.SDD_LOOP_COORDINATOR_TOKEN = readCapabilityFile(
      process.env[COORDINATOR_TOKEN_FILE_ENV]!
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'COORDINATOR_TOKEN_FILE_INVALID')
    process.exit(1)
  }
}
// Rejected commands against an initialized delivery leave one code-only diagnostic line for the
// retrospective; arguments, payloads and credentials are never recorded.
const diagnosticSdd = flagValue(args, '--sdd')
if (diagnosticSdd && !['configuration', 'capabilities'].includes(command.name)) {
  let rejectionCode: string | undefined
  const writeError = console.error
  console.error = (...values: unknown[]) => {
    rejectionCode ??= /^[A-Z][A-Z0-9_]{2,}/.exec(String(values[0] ?? ''))?.[0]
    writeError(...values)
  }
  process.on('exit', (code) => {
    if (code === 0 || !rejectionCode) return
    try {
      recordRejection(diagnosticSdd, command.name, rejectionCode)
    } catch {
      /* Diagnostics never change a command's outcome. */
    }
  })
}
const handler = HANDLERS[command.name]
if (!handler) {
  console.error(`COMMAND_HANDLER_MISSING: ${command.name}`)
  process.exit(2)
}
try {
  const outcome = await handler.run(flagsOf(args.slice(1)))
  console.log(JSON.stringify(outcome.output))
  process.exit(outcome.exit ?? 0)
} catch (error) {
  if (error instanceof UsageError) {
    console.error(error.message)
    process.exit(2)
  }
  console.error(error instanceof Error ? error.message : handler.failure)
  process.exit(handler.failureExit)
}
