import { rolePublicKey } from '../scripts/resource/role-signature'
import { test, expect } from 'bun:test'
import { createHash, createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordEvent } from '../scripts/controllers/record.controller'

test('Coordinator record rejects lossy JSON without writes and preserves legal payload bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'record-json-'))
  const sdd = join(root, 'task.md')
  const state = JSON.stringify({
    protocol: 'control-plane/state-v2',
    phase: 'DISCOVER',
    contract_revision: 'v1',
    revision: 1,
    authority_epoch: 1,
    coordinator_event_keys: { '1': rolePublicKey('token') },
    coordinator_token_hash: createHash('sha256').update('token').digest('hex')
  })
  const submit = (payload: unknown) =>
    recordEvent(sdd, 'coordinator', 'DISCOVER', 'v1', 'observation', payload, 'token')
  try {
    writeFileSync(sdd, 'design')
    writeFileSync(sdd + '.loop.json', state)
    writeFileSync(sdd + '.events.jsonl', '')
    const files = readdirSync(root).sort()
    let reads = 0
    const accessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get() {
        reads++
        return 'changed'
      }
    })
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const sparse = new Array<string>(2)
    sparse[1] = 'hole'
    for (const payload of [
      { value: NaN },
      { value: Infinity },
      { value: Number.MAX_SAFE_INTEGER + 1 },
      { value: undefined },
      { value: () => 'ignored' },
      { value: new Date() },
      { value: sparse },
      accessor,
      cyclic
    ]) {
      expect(() => submit(payload)).toThrow('CANONICAL_')
      expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(state)
      expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe('')
      expect(readdirSync(root).sort()).toEqual(files)
    }
    expect(reads).toBe(0)
    const payload = { z: '取消😀', a: [null, false, 1.25, Number.MAX_SAFE_INTEGER] }
    submit(payload)
    const event = JSON.parse(readFileSync(sdd + '.events.jsonl', 'utf8'))
    expect(event.payload).toEqual(payload)
    expect(Object.keys(event.payload)).toEqual(['z', 'a'])
    const { signature, ...body } = event
    expect(signature).toBe(createHmac('sha256', 'token').update(JSON.stringify(body)).digest('hex'))
    expect(JSON.parse(readFileSync(sdd + '.loop.json', 'utf8')).revision).toBe(2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
