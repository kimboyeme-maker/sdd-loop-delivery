import { test, expect } from 'bun:test'
import { documentPresentation } from '../scripts/domain/document-presentation'

const source = `## Delivery
| id | description | requirement_ids | acceptance_ids |
| --- | --- | --- | --- |
| PC01 | Preserve input \\| output behavior | XQ01 | YS01 |
`
const contract = () => ({
  document_policy: 'sdd-document/v1',
  requirements: [{ id: 'XQ01' }],
  acceptance: [{ id: 'YS01' }],
  presentation: {
    protocol: 'sdd-presentation/v1',
    items: [
      { id: 'PC01', kind: 'batch', source: { document: 'self', heading: 'Delivery', table: 1 } }
    ]
  }
})

test('presentation derives original description and rejects stale or missing links', () => {
  const valid = documentPresentation(contract(), { self: source })!
  expect((valid.items as Record<string, unknown>[])[0]!.description).toBe(
    'Preserve input | output behavior'
  )
  expect(() =>
    documentPresentation(contract(), { self: source.replace('| XQ01 |', '| XQ02 |') })
  ).toThrow('DANGLING')
  expect(() =>
    documentPresentation(contract(), { self: source.replace('description', 'summary') })
  ).toThrow('DESCRIPTION_MISSING')
  expect(() =>
    documentPresentation(contract(), {
      self: source.replace('Preserve input \\| output behavior', 'TODO')
    })
  ).toThrow('MEANINGLESS')
  expect(() => documentPresentation(contract(), { self: source + '\n## Delivery\n' })).toThrow(
    'SOURCE_DRIFT'
  )
  const stale = contract()
  Object.assign(stale.presentation.items[0]!, { description: 'outdated' })
  expect(() => documentPresentation(stale, { self: source })).toThrow('DESCRIPTION_DRIFT')
})

test('fenced examples are not normative tables and legacy documents remain readable', () => {
  expect(
    documentPresentation(contract(), {
      self: source + '\n```md\n| example |\n| --- |\n| value |\n```\n'
    })
  ).not.toBeNull()
  expect(
    documentPresentation({ requirements: [{ id: 'R1' }] }, { self: '| old |\n| --- |\n| legacy |' })
  ).toBeNull()
  for (const id of ['PC1', 'PC-01', 'PC10000']) {
    const invalid = contract()
    invalid.presentation.items[0]!.id = id
    expect(() => documentPresentation(invalid, { self: source.replace('PC01', id) })).toThrow(
      'INVALID'
    )
  }
  for (const id of ['PC01', 'PC003', 'PC0004']) {
    const valid = contract()
    valid.presentation.items[0]!.id = id
    expect(documentPresentation(valid, { self: source.replace('PC01', id) })).not.toBeNull()
  }
})

import { admissionFixture } from './fixtures/admission'
import {
  documentCheck,
  validateDocument,
  validateDraftText
} from '../scripts/controllers/document.controller'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
test('disk and draft use authoritative contract IDs and the same presentation checks', () => {
  const root = mkdtempSync(join(tmpdir(), 'presentation-entry-'))
  try {
    const fixture = admissionFixture()
    fixture.contract.acceptance[0]!.claim.id = 'DL01'
    const current = {
      ...fixture.contract,
      document_policy: 'sdd-document/v1',
      presentation: contract().presentation
    }
    const sections = [
      'Breaking Changes',
      'New/Changed API & Typing',
      'New/Changed Entities & Tools',
      'Implementation Flow & Pseudocode',
      'Delivery & Verification'
    ]
      .map(
        (title) =>
          `## ${title}\nUse the existing isolated value producer; no public API or lifecycle changes.\n`
      )
      .join('\n')
    const text = `<!-- sdd-contract:start -->\n\`\`\`json\n${JSON.stringify(current)}\n\`\`\`\n<!-- sdd-contract:end -->\n${sections}\n${source}`
    const path = join(root, 'task.md')
    writeFileSync(path, text)
    expect(documentCheck(path).valid).toBe(true)
    expect(validateDocument(path).valid).toBe(true)
    expect(validateDraftText(text, path).valid).toBe(true)
    const broken = text.replace('| XQ01 |', '| XQ02 |')
    writeFileSync(path, broken)
    expect(documentCheck(path).valid).toBe(false)
    expect(validateDocument(path).diagnostics).toEqual(validateDraftText(broken, path).diagnostics)
    expect(readFileSync(path, 'utf8')).toBe(broken)
    expect(readdirSync(root)).toEqual(['task.md'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('SHIP gate rows together cover every Must-Ship acceptance', () => {
  const shipSource = (acceptance: string) => `## Delivery
| id | description | requirement_ids | acceptance_ids | gate |
| --- | --- | --- | --- | --- |
| PC01 | Deliver both outcomes | XQ01, XQ02 | YS01, YS02 | |
| MJ01 | Ship after independent verification | XQ01, XQ02 | ${acceptance} | SHIP |
`
  const shipContract = () => ({
    document_policy: 'sdd-document/v1',
    requirements: [
      { id: 'XQ01', kind: 'must-ship', acceptance: ['YS01'] },
      { id: 'XQ02', kind: 'must-ship', acceptance: ['YS02'] },
      { id: 'XQ03', kind: 'non-goal' }
    ],
    acceptance: [{ id: 'YS01' }, { id: 'YS02' }],
    presentation: {
      protocol: 'sdd-presentation/v1',
      items: [
        { id: 'PC01', kind: 'batch', source: { document: 'self', heading: 'Delivery', table: 1 } },
        { id: 'MJ01', kind: 'gate', source: { document: 'self', heading: 'Delivery', table: 1 } }
      ]
    }
  })
  expect(() =>
    documentPresentation(shipContract(), { self: shipSource('YS01, YS02') })
  ).not.toThrow()
  expect(() => documentPresentation(shipContract(), { self: shipSource('YS01') })).toThrow(
    'SDD_PRESENTATION_SHIP_COVERAGE_INCOMPLETE:YS02'
  )
})

test('the current policy requires the declaration and a SHIP row; legacy keeps reading', () => {
  const declared = contract()
  const undeclared = { ...declared, document_policy: undefined }
  // Legacy is how every execution and observer path reads, and it must stay readable.
  expect(documentPresentation(undeclared, { self: source })).not.toBeNull()
  expect(() => documentPresentation(undeclared, { self: source }, 'current')).toThrow(
    'SDD_DOCUMENT_POLICY_REQUIRED'
  )

  const mustShip = {
    ...declared,
    requirements: [{ id: 'XQ01', kind: 'must-ship', acceptance: ['YS01'] }]
  }
  // No SHIP row covers nothing, so the current policy names the whole uncovered set.
  expect(() => documentPresentation(mustShip, { self: source }, 'current')).toThrow(
    'SDD_PRESENTATION_SHIP_COVERAGE_INCOMPLETE:YS01'
  )
  expect(documentPresentation(mustShip, { self: source })).not.toBeNull()
})
