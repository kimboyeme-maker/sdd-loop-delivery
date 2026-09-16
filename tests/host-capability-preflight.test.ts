import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostReceipt } from '../scripts/controllers/host.controller'

type Item = Record<string, unknown>

/** A structurally valid spawn receipt for whichever host the environment selects. */
function receipt(): string {
  const root = mkdtempSync(join(tmpdir(), 'host-capability-'))
  const path = join(root, 'receipt.json')
  writeFileSync(
    path,
    JSON.stringify({
      protocol: 'host-spawn-receipt/v1',
      agent_id: 'agent-1',
      runtime: 'claude-code',
      model: 'opus',
      isolation: 'isolated'
    })
  )
  return path
}

test('preflight states the host limits before anything is dispatched', () => {
  const path = receipt()
  try {
    const capability = (hostReceipt(path) as Item).hostCapability as Item
    // Reuse works without `close`; replacing a role does not, and nothing else proves a released
    // slot. A run that learns this at replacement time has already promised what it cannot do.
    expect(Array.isArray(capability.unavailable)).toBe(true)
    expect(['UNAVAILABLE', 'INTERRUPT_ONLY', 'PROFILE_SUPPORTED']).toContain(
      String(capability.roleReplacement)
    )
    // Without `close` the run may still be able to stand a failed role aside, which is a different
    // promise from closing one and from being unable to do either.
    if (!(capability.unavailable as string[]).includes('close'))
      expect(capability.roleReplacement).toBe('PROFILE_SUPPORTED')
    // Protocol support is not a receipt: an operation nobody has called here is reported apart
    // from one the host does not expose at all, and each carries the evidence level that earned it.
    expect(Array.isArray(capability.unobserved)).toBe(true)
    expect(capability.unavailable).not.toEqual(capability.unobserved)
    for (const entry of capability.unobserved as string[])
      expect(entry).toMatch(/:(schema|partial|none)$/)
    // The command still refuses to manufacture provenance it cannot check.
    expect((hostReceipt(path) as Item).hostIdentityVerified).toBe(false)
  } finally {
    rmSync(join(path, '..'), { recursive: true, force: true })
  }
})
