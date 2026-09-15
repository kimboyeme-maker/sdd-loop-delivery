import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initLoop } from '../scripts/controllers/init.controller'
import { authBootstrap } from '../scripts/controllers/auth-bootstrap.controller'
import { recordEvent } from '../scripts/controllers/record.controller'
import { transition } from '../scripts/controllers/transition.controller'
import { transactionRecover } from '../scripts/controllers/transaction-recover.controller'
import { lockRecover } from '../scripts/controllers/lock-recover.controller'
import { status } from '../scripts/controllers/read-only.controller'
import { assertCurrentSource } from '../scripts/helpers/source-binding'

test('foreign or missing engine protocols cannot be read as native or acquire authority', () => {
  const root = mkdtempSync(join(tmpdir(), 'engine-isolation-'))
  const sdd = join(root, 'task.md')
  const source = '# isolated design'
  const fingerprint = createHash('sha256').update(source).digest('hex')
  const native = {
    protocol: 'control-plane/state-v2',
    phase: 'DISCOVER',
    revision: 1,
    contract_revision: 'v1',
    authority_epoch: 1,
    sdd_fingerprint: fingerprint,
    requirements: { XQ01: 'pending' },
    completed_attempts: 3,
    coordinator_token_hash: createHash('sha256').update('token').digest('hex')
  }
  try {
    writeFileSync(sdd, source)
    for (const protocol of [undefined, null, 'control-plane/state-v1', 'foreign/v2', 2]) {
      const state = { ...native, protocol }
      writeFileSync(sdd + '.loop.json', JSON.stringify(state))
      writeFileSync(sdd + '.events.jsonl', '')
      const snapshot = () =>
        readdirSync(root)
          .sort()
          .map((name) => [name, readFileSync(join(root, name)).toString('base64')])
      const before = snapshot()
      for (const operation of [
        () => initLoop(sdd, 4),
        () => authBootstrap(sdd, 'DISCOVER', 'v1', 'yes', 'token'),
        () => recordEvent(sdd, 'coordinator', 'DISCOVER', 'v1', 'coordination_note', {}, 'token'),
        () => transition(sdd, 'coordinator', 'DISCOVER', 'v1', 'BLOCKED', 'token'),
        () => transactionRecover(sdd, 'coordinator', 'DISCOVER', 'v1', 'yes', 'token'),
        () => lockRecover(sdd, '', 'yes', 'yes', 'token'),
        () => status(sdd),
        () => assertCurrentSource(state, sdd)
      ]) {
        expect(operation).toThrow('CONTROL_STATE_PROTOCOL_UNSUPPORTED')
        expect(snapshot()).toEqual(before)
      }
    }
    writeFileSync(sdd + '.loop.json', JSON.stringify(native))
    expect(initLoop(sdd, 4)).toEqual(native)
    expect(transactionRecover(sdd, 'coordinator', 'DISCOVER', 'v1', 'yes', 'token').status).toBe(
      'nothing-pending'
    )
    expect(lockRecover(sdd, '', 'yes', 'yes', 'token').status).toBe('nothing-present')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
