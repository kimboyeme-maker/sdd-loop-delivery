import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { hostReceipt } from '../scripts/controllers/host.controller'

test('a locally fabricated but well-shaped host receipt never becomes host attestation', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-provenance-'))
  const path = join(root, 'receipt.json')
  const fields = {
    protocol: 'host-spawn-receipt/v1',
    agent_id: '/root/coordinator',
    runtime: 'claimed-runtime',
    model: 'claimed-model',
    isolation: 'claimed-isolation'
  }
  try {
    const source = JSON.stringify(fields)
    writeFileSync(path, source)
    expect(hostReceipt(path)).toMatchObject({
      ...fields,
      schemaValid: true,
      verified: false,
      hostIdentityVerified: false,
      verificationScope: 'submitted-fields-only'
    })
    expect(readFileSync(path, 'utf8')).toBe(source)
    expect(readdirSync(root)).toEqual(['receipt.json'])
    writeFileSync(path, JSON.stringify({ ...fields, verified: true }))
    expect(() => hostReceipt(path)).toThrow('HOST_RECEIPT_INVALID')
    writeFileSync(path, JSON.stringify(fields))
    expect(hostReceipt(path).schemaValid).toBe(true)
    expect(hostReceipt(path).verified).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
