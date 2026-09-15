#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import policy from '../agents/roles.json'
import { hostProfile, HOST_OPERATIONS, operatorRuntime } from './config/host'
import { roleTable } from './config/roles'
import * as constants from './config/constants'
import { phaseTransitions } from './domain/policies/phase'
import { ROLE_EVENT_PHASES } from './domain/policies/role-event-phase'

type Row = readonly (string | number | boolean | null | undefined)[]
const table = (header: Row, rows: readonly Row[]): string[] => [
  `| ${header.join(' | ')} |`,
  `| ${header.map(() => '---').join(' | ')} |`,
  ...rows.map(
    (row) => `| ${row.map((cell) => String(cell ?? '').replaceAll('|', '\\|')).join(' | ')} |`
  )
]
const code = (values: readonly string[]) => values.map((value) => `\`${value}\``).join(', ')

/** Render reviewable tables from the executable configuration; never edit the output by hand. */
export function renderConfiguration(): string {
  const roles = policy.roles as Record<string, Record<string, unknown>>
  const title = (name: string) => name[0]!.toUpperCase() + name.slice(1)
  const scalars = Object.entries(constants).filter(([, value]) =>
    ['string', 'number', 'boolean'].includes(typeof value)
  )
  const tables = Object.entries(constants)
    .filter(([, value]) => typeof value === 'object')
    .map(([name]) => name)
  return [
    '# Configuration',
    '',
    'Generated from `agents/roles.json`, `scripts/config/constants.ts` and the phase policies; edit those sources, then run `bun run render:configuration`. `agents/openai.yaml` only controls the skill picker.',
    '',
    '## Agent roles',
    '',
    ...table(
      ['Role', 'Tier', 'Model', 'Reasoning', 'New runtime context', 'Authority'],
      roleTable().map((row) => [
        row.role,
        row.runtime_tier ?? 'Invoking main thread',
        row.model ?? (row.runtime_tier ? 'Host default' : 'Invoking main thread'),
        row.reasoning_effort ?? 'Inherited',
        row.context,
        (roles[row.role.toLowerCase()]?.description as string) ?? row.owns
      ])
    ),
    '',
    `Models are resolved from the role tier through the active host profile (\`${hostProfile().id}\`, \`agents/hosts/*.json\`); select another with \`SDD_LOOP_HOST\` or \`SDD_LOOP_HOST_PROFILE_FILE\`. Read the live projection with \`bun scripts/main.ts configuration\`.`,
    '',
    '## Host operations',
    '',
    ...table(
      ['Operation', 'Available', 'Call', 'Parameters'],
      HOST_OPERATIONS.map((name) => {
        const operation = hostProfile().operations[name]
        return [
          `\`${name}\``,
          operation.available,
          operation.available ? `\`${operation.call}\`` : (operation.reason ?? ''),
          (operation.params ?? []).join(', ')
        ]
      })
    ),
    '',
    '## Operator profiles',
    '',
    ...table(
      ['Profile', 'Tier', 'Model', 'Reasoning', 'Use'],
      Object.entries(policy.roles.operator.profiles).map(([name, entry]) => [
        `\`${name}\``,
        entry.runtime_tier,
        operatorRuntime(name).spawn_model ?? 'Host default',
        operatorRuntime(name).reasoning_effort ?? 'Inherited',
        entry.description
      ])
    ),
    '',
    `\`${policy.roles.operator.default_profile}\` is the default. \`bounded\` requires a signed closed mechanical route; it is never inferred from prompt length or model price.`,
    '',
    '## Protocol constants',
    '',
    'Test time, share, file-count and acceptance-timeout constants are defaults. Larger declared limits require acceptance-bound justification; actual runs remain bounded by the admitted allowance and lease.',
    '',
    ...table(
      ['Constant', 'Current value'],
      scalars.map(([name, value]) => [`\`${name}\``, `\`${String(value)}\``])
    ),
    '',
    '## SDD document IDs',
    '',
    `Pattern: \`${constants.SDD_DOCUMENT_ID_PATTERN}\`. IDs start at 01, extend to four digits and are never recycled.`,
    '',
    ...table(
      ['Prefix', 'Category'],
      Object.entries(constants.SDD_DEFAULT_ID_PREFIXES).map(([prefix, kind]) => [
        `\`${prefix}\``,
        kind
      ])
    ),
    '',
    '## Agent event authority',
    '',
    ...table(
      ['Role', 'Allowed authored events'],
      Object.entries(roles).map(([name, entry]) => [
        title(name),
        code((entry.events as string[] | undefined) ?? []) || 'None'
      ])
    ),
    '',
    '## Role event phases',
    '',
    ...table(
      ['Role', 'Event', 'Allowed phases'],
      Object.entries(ROLE_EVENT_PHASES).flatMap(([role, events]) =>
        Object.entries(events).map(([event, phases]) => [title(role), `\`${event}\``, code(phases)])
      )
    ),
    '',
    '## Phase transitions',
    '',
    ...table(
      ['Phase', 'Allowed next phases'],
      Object.entries(phaseTransitions()).map(([phase, next]) => [
        `\`${phase}\``,
        code(next) || 'terminal'
      ])
    ),
    '',
    '`PAUSED` and `CANCELLED` are entered only through `user-control`; they are not ordinary transitions.',
    '',
    '## Other executable tables',
    '',
    code(tables),
    ''
  ].join('\n')
}

if (import.meta.main) {
  const path = join(import.meta.dir, '..', 'configuration.md')
  const expected = renderConfiguration()
  if (process.argv.includes('--check')) {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== expected) {
      console.error('CONFIGURATION_STALE: run bun run render:configuration')
      process.exit(1)
    }
    console.log(JSON.stringify({ protocol: 'configuration-check/v1', valid: true }))
  } else writeFileSync(path, expected)
}
