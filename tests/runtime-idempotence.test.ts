import { rolePublicKey } from '../scripts/resource/role-signature'
import { bindEventLog, eventLogBinding } from '../scripts/resource/store/event-log-binding'
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runtimeRecord } from '../scripts/controllers/runtime-record.controller'

test('runtime observations require authentic unique receipts and compare payloads independently of key order', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-idempotence-')),
    sdd = join(root, 'sdd.md')
  const payload = {
    id: 'observation',
    controller: sdd,
    coordinator_agent_id: 'coordinator',
    authority_epoch: 1,
    previous_record_id: null,
    agent_role: 'operator',
    host: {
      model: 'gpt-5.6-terra',
      reasoning_effort: 'medium',
      status: 'idle',
      controllable: true,
      writer_stopped: true,
      commands_stopped: true,
      close_available: false,
      conversation_id: 'isolated',
      ancestor_ids: ['coordinator'],
      confirmed_by: 'coordinator'
    },
    agent_id: 'operator',
    action: 'observe',
    evidence: 'host result'
  }
  const call = (value: object = payload) =>
    runtimeRecord(sdd, 'coordinator', 'IMPLEMENTING', 'v1', value, 'token')
  try {
    writeFileSync(sdd, '# fixture')
    writeFileSync(
      sdd + '.loop.json',
      JSON.stringify({
        protocol: 'control-plane/state-v2',
        phase: 'IMPLEMENTING',
        revision: 1,
        authority_epoch: 1,
        coordinator_agent_id: 'coordinator',
        coordinator_event_keys: { '1': rolePublicKey('token') },
        contract_revision: 'v1',
        coordinator_token_hash: createHash('sha256').update('token').digest('hex')
      })
    )
    const result = call()
    const state = readFileSync(sdd + '.loop.json'),
      log = readFileSync(sdd + '.events.jsonl', 'utf8')
    expect(call(Object.fromEntries(Object.entries(payload).reverse()))).toEqual(result)
    const forged = JSON.parse(log)
    delete forged.signature
    for (const [text, error] of [
      [JSON.stringify(forged) + '\n', 'RUNTIME_OBSERVATION_SIGNATURE_INVALID'],
      [log + log, 'RUNTIME_OBSERVATION_AMBIGUOUS']
    ]) {
      // Rebind the altered log so the case tests observation evidence, not log integrity.
      const bound = bindEventLog(state, eventLogBinding(Buffer.from(text!)))
      writeFileSync(sdd + '.loop.json', bound)
      writeFileSync(sdd + '.events.jsonl', text!)
      expect(() => call()).toThrow(error!)
      expect(readFileSync(sdd + '.loop.json').equals(bound)).toBe(true)
      expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe(text!)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
