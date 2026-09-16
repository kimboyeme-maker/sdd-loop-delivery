import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNativeChain } from './fixtures/native-chain'

type Item = Record<string, unknown>

test('a verdict naming the wrong semantic map is refused when written, not at the transition', () => {
  const root = mkdtempSync(join(tmpdir(), 'verdict-shape-'))
  const chain = createNativeChain(root)
  try {
    chain.setup()
    chain.toArchitectVerify()
    const architect = chain.start('architect')
    chain.architectRun(architect)
    const payload = chain.verificationPayload() as Item
    // The IDs of the SDD's prose, not of the admitted ownership map: the mistake two independent
    // roles made in a real delivery, because the field name does not say which namespace it means.
    const wrong = {
      ...payload,
      semantic_ownership_review: {
        ...(payload.semantic_ownership_review as Item),
        semantic_ids: ['SM01', 'SM02']
      }
    }
    expect(() => chain.record('architect', architect, 'verification', wrong)).toThrow(
      'SEMANTIC_OWNERSHIP_REVIEW_SCOPE_INVALID'
    )
    // The lease survives the refusal, so the reviewer can correct its own verdict. Before this
    // check moved to the producer, the rejected verdict was already signed and had ended the lease.
    expect(() => chain.record('architect', architect, 'verification', payload)).not.toThrow()
  } finally {
    chain.restore()
    rmSync(root, { recursive: true, force: true })
  }
})
