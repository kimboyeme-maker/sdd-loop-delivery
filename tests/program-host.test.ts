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

test('an addressable creator is still used; only an unaddressable one falls back', async () => {
  const { creationHostCall } = await import('../scripts/services/program-workflow')
  // The rule is about addressability, not about a host name: a creator whose children can be
  // driven is dispatched to, and the fallback exists for the case where they cannot.
  expect(
    creationHostCall({ available: true, call: 'create_thread', params: ['prompt'] })
  ).toMatchObject({ operation: 'task_create', call: 'create_thread' })
  expect(
    creationHostCall({
      available: true,
      call: 'create_thread',
      params: ['prompt'],
      worktree_addressable: false
    })
  ).toMatchObject({ available: false, fallback: 'USER_CREATES_TASK' })
  expect(creationHostCall({ available: false, reason: 'no such tool' })).toMatchObject({
    available: false,
    reason: 'no such tool',
    fallback: 'USER_CREATES_TASK'
  })
})
