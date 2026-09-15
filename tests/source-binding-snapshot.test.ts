import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { assertCurrentSource } from '../scripts/helpers/source-binding'

test('source binding validates supplied bytes without reopening a different document snapshot', () => {
  const source = Buffer.from('# bound document')
  const state = {
    protocol: 'control-plane/state-v2',
    sdd_fingerprint: createHash('sha256').update(source).digest('hex')
  }
  expect(() => assertCurrentSource(state, '/does-not-exist.md', source)).not.toThrow()
  expect(() =>
    assertCurrentSource(state, '/does-not-exist.md', Buffer.from('# changed document'))
  ).toThrow('SDD_SOURCE_CHANGED_REQUIRES_AMEND')
  expect(() => assertCurrentSource(state, '/does-not-exist.md', Buffer.alloc(0))).toThrow(
    'SDD_SOURCE_CHANGED_REQUIRES_AMEND'
  )
})
