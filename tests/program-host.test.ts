import { expect, test } from 'bun:test'
import { hostProfile } from '../scripts/config/host'

const PROGRAM_OPERATIONS = [
  'task_create',
  'task_message',
  'task_wait',
  'task_list',
  'wake_schedule',
  'project_discover'
] as const

test('every bundled host declares program operations, and an unknown host offers none', () => {
  for (const id of ['codex', 'claude-code', 'generic']) {
    const profile = hostProfile({ SDD_LOOP_HOST: id })
    for (const name of PROGRAM_OPERATIONS) expect(profile.operations[name]).toBeDefined()
  }
  const generic = hostProfile({ SDD_LOOP_HOST: 'generic' })
  expect(PROGRAM_OPERATIONS.some((name) => generic.operations[name].available)).toBe(false)
  // A host without task creation falls back to a user-started task, never an in-session subagent.
  expect(hostProfile({ SDD_LOOP_HOST: 'claude-code' }).operations.task_create.available).toBe(false)
})
