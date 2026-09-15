import { COMMANDS } from './commands/registry'
import { HANDLERS } from './commands/handlers'

/** Every registered command has a handler in the composition root, and every handler is registered. */
const registered = new Set(COMMANDS.map(({ name }) => name))
const handled = new Set(Object.keys(HANDLERS))
const missingHandler = [...registered].filter((name) => !handled.has(name))
const unknownHandler = [...handled].filter((name) => !registered.has(name))
if (missingHandler.length || unknownHandler.length) {
  console.error(JSON.stringify({ protocol: 'command-coverage/v1', missingHandler, unknownHandler }))
  process.exit(1)
}
console.log(JSON.stringify({ protocol: 'command-coverage/v1', registered: COMMANDS.length }))
