import { COMMANDS } from './commands/registry'
import { COMMAND_OPTIONS } from './commands/options'

/** Check native inventory consistency, not implementation or semantic parity with another engine. */
const names = COMMANDS.map((command) => command.name).sort()
if (
  new Set(names).size !== names.length ||
  JSON.stringify(names) !== JSON.stringify(Object.keys(COMMAND_OPTIONS).sort())
)
  throw new Error('COMMAND_OPTIONS_INVENTORY_MISMATCH')
for (const [command, flags] of Object.entries(COMMAND_OPTIONS)) {
  if (
    !Array.isArray(flags) ||
    new Set(flags).size !== flags.length ||
    flags.some((flag) => !/^--[a-z][a-z0-9-]*$/.test(flag))
  )
    throw new Error(`COMMAND_OPTIONS_INVALID:${command}`)
}
console.log(
  JSON.stringify({
    protocol: 'command-options-check/v1',
    valid: true,
    commands: names.length,
    scope: 'native-inventory-only'
  })
)
