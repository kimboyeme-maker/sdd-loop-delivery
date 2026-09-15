import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertPathInScope } from '../scripts/domain/policies/scope'
import { lintOperatorReceipt } from '../scripts/controllers/receipt.controller'

test('scope and receipt reject traversal in both separator forms', () => {
  const root = mkdtempSync(join(tmpdir(), 'scope-adversarial-'))
  const receipt = join(root, 'receipt.json')
  const check = (path: string) => {
    writeFileSync(
      receipt,
      JSON.stringify({
        role: 'Operator',
        agent_id: 'op',
        lease_id: 'lease',
        status: 'partial',
        changes: [{ path, action: 'MODIFIED' }]
      })
    )
    return lintOperatorReceipt(receipt)
  }
  try {
    for (const path of [
      'packages/app/../secret.ts',
      'packages\\app\\..\\secret.ts',
      'C:\\secret.ts',
      'C:secret.ts',
      '\\\\server\\file',
      '/secret.ts',
      'packages/app/\0bad',
      '.'
    ]) {
      expect(() => assertPathInScope(path, ['packages/app'], [])).toThrow('WORKSPACE_PATH_INVALID')
      expect(check(path).valid).toBe(false)
    }
    for (const path of [
      'packages/app/file.ts',
      './packages/app/文件 name.ts',
      'packages\\app\\file.ts'
    ]) {
      expect(() =>
        assertPathInScope(path, ['@app'], [{ root: 'packages/app', identity: '@app' }])
      ).not.toThrow()
      expect(check(path).valid).toBe(true)
    }
    expect(() => assertPathInScope('packages/app-other/file.ts', ['packages/app'], [])).toThrow(
      'LEASE_SCOPE_DENIED'
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
