import { transition } from '../scripts/controllers/transition.controller'
import { recordEvent } from '../scripts/controllers/record.controller'
import { expect, test } from 'bun:test'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initLoop } from '../scripts/controllers/init.controller'
import { authBootstrap } from '../scripts/controllers/auth-bootstrap.controller'
import { dispatch } from '../scripts/controllers/dispatch.controller'
import { admissionFixture } from './fixtures/admission'

test('product dispatch requires a current signed admission and keeps rejection zero-write', () => {
  const root = mkdtempSync(join(tmpdir(), 'admission-authority-')),
    sdd = join(root, 'task.md'),
    workspace = join(root, 'product')
  const issue = (scope = ['src'], packet?: string) =>
    dispatch(
      sdd,
      'coordinator',
      'OPERATOR_READBACK',
      'v1',
      'operator',
      'operator',
      1,
      5,
      scope,
      'fixture',
      'token',
      { worktreeRoot: workspace, ...(packet === undefined ? {} : { packet }) }
    )
  try {
    mkdirSync(workspace)
    expect(Bun.spawnSync(['git', 'init', '-q'], { cwd: workspace }).exitCode).toBe(0)
    writeFileSync(sdd, admissionFixture('src').source)
    initLoop(sdd, 4)
    authBootstrap(sdd, 'DISCOVER', 'v1', 'yes', 'token')
    transition(sdd, 'coordinator', 'DISCOVER', 'v1', 'ARCHITECT', 'token')
    transition(sdd, 'coordinator', 'ARCHITECT', 'v1', 'CONTRACT_DRAFT', 'token')
    const unadmittedState = readFileSync(sdd + '.loop.json')
    const unadmittedEvents = readFileSync(sdd + '.events.jsonl')
    expect(() =>
      transition(sdd, 'coordinator', 'CONTRACT_DRAFT', 'v1', 'CONTRACT_ADMITTED', 'token')
    ).toThrow('CONTRACT_ADMISSION_GATE_MISSING')
    expect(readFileSync(sdd + '.loop.json')).toEqual(unadmittedState)
    expect(readFileSync(sdd + '.events.jsonl')).toEqual(unadmittedEvents)
    const receipt = recordEvent(
      sdd,
      'coordinator',
      'CONTRACT_DRAFT',
      'v1',
      'contract_admission',
      admissionFixture('src').payload,
      'token'
    )
    transition(sdd, 'coordinator', 'CONTRACT_DRAFT', 'v1', 'CONTRACT_ADMITTED', 'token')
    transition(sdd, 'coordinator', 'CONTRACT_ADMITTED', 'v1', 'OPERATOR_READBACK', 'token')
    const state = readFileSync(sdd + '.loop.json', 'utf8'),
      events = readFileSync(sdd + '.events.jsonl', 'utf8')
    const reset = () => {
      writeFileSync(sdd + '.loop.json', state)
      writeFileSync(sdd + '.events.jsonl', events)
    }
    for (const scope of [['src'], ['src/file.ts']]) {
      reset()
      issue(scope, 'PC01')
      expect(
        JSON.parse(readFileSync(sdd + '.loop.json', 'utf8')).active_lease.admission_event_id
      ).toBe(receipt.eventId)
    }
    for (const [scope, packet, code] of [
      [['src-extra'], 'PC01', 'ADMISSION_DISPATCH_SCOPE_INVALID'],
      [['.'], 'PC01', 'ADMISSION_DISPATCH_SCOPE_INVALID'],
      [['src'], 'PC99', 'ADMISSION_DISPATCH_PACKET_INVALID']
    ] as const) {
      reset()
      expect(() => issue([...scope], packet)).toThrow(code)
      expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(state)
      expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe(events)
    }
    const initialEvents = events
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    for (const mutate of [
      (items: Record<string, unknown>[]) => {
        items.find((item) => item.type === 'contract_admission')!.coordinator_proof = 'forged'
      },
      (items: Record<string, unknown>[]) => {
        items.push(items.find((item) => item.type === 'contract_admission')!)
      },
      (items: Record<string, unknown>[]) => {
        items.push({
          type: 'contract_admission',
          role: 'coordinator',
          payload: { decision: 'ADMIT' }
        })
      },
      (items: Record<string, unknown>[]) => {
        items.push({ type: 'timeout_decision' })
      }
    ]) {
      reset()
      const items = structuredClone(initialEvents)
      mutate(items)
      const altered = items.map((item) => JSON.stringify(item)).join('\n') + '\n'
      writeFileSync(sdd + '.events.jsonl', altered)
      expect(() => issue()).toThrow()
      expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(state)
      expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe(altered)
    }
    for (const patch of [
      { authority_epoch: Number(JSON.parse(state).authority_epoch) + 1 },
      { pending_user_decision: { question: 'approve?' } },
      { protocol: 'foreign-engine' }
    ]) {
      reset()
      const altered = JSON.stringify({ ...JSON.parse(state), ...patch })
      writeFileSync(sdd + '.loop.json', altered)
      expect(() => issue()).toThrow()
      expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(altered)
      expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe(events)
    }
    expect(readdirSync(root).sort()).toEqual([
      'product',
      'task.md',
      'task.md.events.jsonl',
      'task.md.loop.json'
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
