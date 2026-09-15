import { test, expect } from 'bun:test'
import { contextFragments } from '../scripts/helpers/context-fragments'

test('fragments preserve every original character including fenced examples and CRLF', () => {
  const source = '前言\r\n## First\r\n正文\r\n```ts\r\n## Fake\r\n```\r\n### Detail\r\n末尾'
  const fragments = contextFragments(source)
  expect(fragments.map((item) => item.fragment)).toEqual(['@preamble', '## First', '### Detail'])
  expect(fragments.map((item) => item.text).join('')).toBe(source)
  expect(fragments.reduce((bytes, item) => bytes + item.bytes, 0)).toBe(Buffer.byteLength(source))
  const changed = contextFragments(source.replace('末尾', '修改'))
  expect(changed[1]!.sha256).toBe(fragments[1]!.sha256)
  expect(changed[2]!.sha256).not.toBe(fragments[2]!.sha256)
})

test('duplicate section identities disable partial reuse, including empty and unheaded documents', () => {
  for (const source of ['## Same\na\n## Same\nb\n', '', 'plain text']) {
    const fragments = contextFragments(source)
    expect(fragments).toHaveLength(1)
    expect(fragments[0]!.fragment).toBe('@document')
    expect(fragments[0]!.text).toBe(source)
  }
})
