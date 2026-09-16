import { expect, test } from 'bun:test'
import { hostProfile } from '../scripts/config/host'

const HOSTS = ['codex', 'claude-code', 'generic'] as const

test('every profile says where a role may run, and a declared mode names real operations', () => {
  for (const id of HOSTS) {
    process.env.SDD_LOOP_HOST = id
    const hosting = hostProfile().role_hosting
    expect(hosting).toBeDefined()
    const chosen = hosting!.modes[hosting!.default]
    // The default must be a mode the host has AND the controller can drive, or the plan would emit
    // a create call it cannot follow with a continue or a wait.
    expect(chosen?.available).toBe(true)
    expect(chosen?.wired).toBe(true)
    for (const [, entry] of Object.entries(hosting!.modes)) {
      // Every mode names the three operations a role needs, available or not, so an unavailable
      // mode still says what it would have used and why it cannot.
      expect(Object.keys(entry!.operations).sort()).toEqual(['continue', 'create', 'wait'])
      for (const name of Object.values(entry!.operations))
        expect(hostProfile().operations[name]).toBeDefined()
      if (entry!.available !== true) expect(typeof entry!.reason).toBe('string')
    }
  }
  delete process.env.SDD_LOOP_HOST
})

test('a mode is only as good as its evidence, and thread hosting states its conditions', () => {
  process.env.SDD_LOOP_HOST = 'codex'
  const thread = hostProfile().role_hosting!.modes.thread!
  expect(thread.available).toBe(true)
  expect(thread.operations.create).toBe('task_create')
  // The conditions are the point: a thread role inherits the workspace toolchain, and that has to
  // be readable before anything is dispatched rather than discovered when a command behaves oddly.
  expect(thread.requires!.join(' ')).toContain('workspace toolchain')
  expect(thread.requires!.join(' ')).toContain('runningBun')
  // Proven as a runtime is not proven as a delivery, and the profile says so rather than implying it.
  expect(thread.requires!.join(' ')).toContain('No delivery has been completed')
  // Available to the host is not drivable by this controller, and conflating them would promise a
  // switch that silently falls back.
  expect(thread.wired).toBe(false)

  process.env.SDD_LOOP_HOST = 'claude-code'
  const absent = hostProfile().role_hosting!.modes.thread!
  expect(absent.available).toBe(false)
  expect(absent.reason).toContain('task_create is unavailable')
  delete process.env.SDD_LOOP_HOST
})
