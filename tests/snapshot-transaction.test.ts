import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSnapshot, sidecarPaths } from '../scripts/resource/state'
import { commitSidecar, recoverSidecar } from '../scripts/resource/store/sidecar-transaction'

test('stable partial transaction bytes are not exposed as a committed snapshot', () => {
  for (const stop of ['journal', 'events', 'state']) {
    const root = mkdtempSync(join(tmpdir(), 'snapshot-transaction-'))
    const sdd = join(root, 'sdd.md'),
      files = sidecarPaths(sdd)
    const sign = (bytes: Uint8Array) => createHmac('sha256', 'test-key').update(bytes).digest('hex')
    const security = { sign, verify: (bytes: Uint8Array, proof: string) => sign(bytes) === proof }
    try {
      const state = Buffer.from('{"protocol":"control-plane/state-v2","revision":1}'),
        events = Buffer.from('')
      writeFileSync(files.state, state)
      writeFileSync(files.events, events)
      expect(() =>
        commitSidecar(
          files,
          Buffer.from('{"protocol":"control-plane/state-v2","revision":2}'),
          Buffer.from('{"event_id":"new"}\n'),
          security,
          { state },
          (stage) => {
            if (stage === stop) throw Error('interrupted')
          }
        )
      ).toThrow('interrupted')
      const before = [files.state, files.events, files.journal].map((path) => readFileSync(path))
      expect(() => readSnapshot(sdd)).toThrow('CONTROL_TRANSACTION_PENDING')
      expect([files.state, files.events, files.journal].map((path) => readFileSync(path))).toEqual(
        before
      )
      expect(recoverSidecar(files, security)).toBe('recovered')
      expect(readSnapshot(sdd)).toMatchObject({ state: { revision: 2 }, eventCount: 1 })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})
