import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNativeChain } from './fixtures/native-chain'
import { runtimePlan } from '../scripts/services/runtime-plan'

type Item = Record<string, unknown>

test('a supervised wait holds a turn for at most a minute while still naming its real deadline', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-wait-'))
  const chain = createNativeChain(root)
  try {
    chain.setup()
    chain.admit()
    chain.readback()
    const plan = runtimePlan(chain.sdd) as Item
    const wait = (plan.calls as Item[]).find((call) => call.operation === 'wait')
    expect(wait).toBeDefined()
    const args = wait!.args as Item
    // The program reference bounds a blocking wait at 60 seconds while actively communicating, so
    // a plan that asked for ten minutes would tell the Coordinator to go silent through it.
    expect(Number(args.timeout_ms)).toBeLessThanOrEqual(60_000)
    // The deadline travels as plan context, never as a host argument: the call carries only what
    // the profile declares, and an argument the host does not know would be dropped silently.
    expect(args.until_deadline_ms).toBeUndefined()
    expect(Number(wait!.deadline_ms)).toBeGreaterThanOrEqual(Number(args.timeout_ms))
    expect(plan.executes).toBe(false)
  } finally {
    chain.restore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a dispatch prompt carries the facts the controller already has, and nothing it invents', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-handoff-'))
  const chain = createNativeChain(root)
  try {
    chain.setup()
    chain.admit()
    chain.advance('CONTRACT_ADMITTED', 'OPERATOR_READBACK')
    const plan = runtimePlan(chain.sdd) as Item
    const messages = (plan.calls as Item[])
      .map((call) => String((call.args as Item).message ?? (call.args as Item).prompt ?? ''))
      .filter(Boolean)
    expect(messages.length).toBeGreaterThan(0)
    // A hand-assembled prompt is where a skill path or an SDD path goes missing; these come from
    // the controller, so they cannot.
    for (const message of messages) {
      expect(message).toContain(chain.sdd)
      // No placeholder survives: every path is resolved, so nothing is left for a caller to fill in.
      expect(message).not.toMatch(/<[^>]+>/)
    }
    // The plan still grants nothing: guidance, scope and the lease belong to the dispatch itself.
    expect(messages.some((message) => message.includes('dispatch'))).toBe(true)
    expect(plan.executes).toBe(false)
  } finally {
    chain.restore()
    rmSync(root, { recursive: true, force: true })
  }
})
