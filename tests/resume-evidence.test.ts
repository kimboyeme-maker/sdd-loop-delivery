import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { userControl } from '../scripts/controllers/user-control.controller'
import { rolePublicKey } from '../scripts/resource/role-signature'
import { bindEventLog, eventLogBinding } from '../scripts/resource/store/event-log-binding'

test('resume uses signed pause target and rejects altered targets or evidence without writes', () => {
  const root = mkdtempSync(join(tmpdir(), 'resume-evidence-')),
    sdd = join(root, 'sdd.md')
  try {
    writeFileSync(sdd, '# fixture')
    writeFileSync(
      sdd + '.loop.json',
      JSON.stringify({
        protocol: 'control-plane/state-v2',
        phase: 'IMPLEMENTING',
        revision: 1,
        contract_revision: 'v1',
        authority_epoch: 1,
        coordinator_event_keys: { '1': rolePublicKey('token') },
        coordinator_token_hash: createHash('sha256').update('token').digest('hex')
      })
    )
    writeFileSync(sdd + '.events.jsonl', '')
    userControl(
      sdd,
      'coordinator',
      'IMPLEMENTING',
      'v1',
      'pause',
      'user paused',
      'yes',
      undefined,
      undefined,
      'token'
    )
    const paused = readFileSync(sdd + '.loop.json', 'utf8'),
      events = readFileSync(sdd + '.events.jsonl', 'utf8')
    for (const target of ['SHIP', 'FINAL_VERIFY', 'unknown']) {
      const altered = JSON.stringify({ ...JSON.parse(paused), paused_from: target })
      writeFileSync(sdd + '.loop.json', altered)
      expect(() =>
        userControl(
          sdd,
          'coordinator',
          'PAUSED',
          'v1',
          'resume',
          'continue',
          'yes',
          undefined,
          undefined,
          'token'
        )
      ).toThrow('USER_CONTROL_PAUSE_EVIDENCE_INVALID')
      expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(altered)
      expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe(events)
    }
    // Rebind the emptied log so the case tests pause evidence, not log integrity.
    const unpaused = bindEventLog(Buffer.from(paused), eventLogBinding(Buffer.alloc(0))).toString()
    writeFileSync(sdd + '.loop.json', unpaused)
    writeFileSync(sdd + '.events.jsonl', '')
    expect(() =>
      userControl(
        sdd,
        'coordinator',
        'PAUSED',
        'v1',
        'resume',
        'continue',
        'yes',
        undefined,
        undefined,
        'token'
      )
    ).toThrow('USER_CONTROL_PAUSE_EVIDENCE_REQUIRED')
    expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(unpaused)
    writeFileSync(sdd + '.loop.json', paused)
    writeFileSync(sdd + '.events.jsonl', events)
    userControl(
      sdd,
      'coordinator',
      'PAUSED',
      'v1',
      'resume',
      'continue',
      'yes',
      undefined,
      undefined,
      'token'
    )
    expect(JSON.parse(readFileSync(sdd + '.loop.json', 'utf8'))).toMatchObject({
      phase: 'IMPLEMENTING',
      revision: 3
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
