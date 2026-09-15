import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { status } from '../scripts/controllers/read-only.controller'

test('public status excludes private lease fields without changing stored authority', () => {
  const root = mkdtempSync(join(tmpdir(), 'status-privacy-'))
  const sdd = join(root, 'sdd.md')
  try {
    writeFileSync(sdd, '# fixture')
    const original = JSON.stringify({
      protocol: 'control-plane/state-v2',
      phase: 'IMPLEMENT',
      active_lease: {
        lease_id: 'lease',
        agent_id: 'operator',
        role: 'operator',
        authority_epoch: 1,
        token: 'private-capability',
        token_hash: 'private-hash',
        capability_path: 'private-path',
        worktree_baseline: { content: 'private-baseline' },
        unknown_future_secret: 'private-future'
      }
    })
    writeFileSync(sdd + '.loop.json', original)
    const view = status(sdd) as { activeLease: object }
    expect(view.activeLease).toEqual({
      lease_id: 'lease',
      agent_id: 'operator',
      role: 'operator',
      authority_epoch: 1
    })
    expect(JSON.stringify(view)).not.toContain('private-')
    expect(JSON.stringify(status(sdd, true))).not.toContain('private-')
    expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(original)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
