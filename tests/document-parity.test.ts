import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateDocument, validateDraftText } from '../scripts/controllers/document.controller'
import { resolveDesignDetail } from '../scripts/domain/design-detail'

test('disk and memory share design checks and fenced headings cannot supply missing sections', () => {
  const root = mkdtempSync(join(tmpdir(), 'design-parity-')),
    file = join(root, 'draft.md')
  const headings = [
    'Breaking Changes',
    'New/Changed API & Typing',
    'New/Changed Entities & Tools',
    'Implementation Flow & Pseudocode',
    'Delivery & Verification'
  ]
  const good = headings
    .map((heading) => '## ' + heading + '\n### Details\nConcrete design content.\n')
    .join('\n')
  try {
    for (const text of [
      good,
      '~~~md\n' + good + '~~~\n',
      good.replace('Concrete design content.', ''),
      'Mention sdd-contract in prose\n'
    ]) {
      writeFileSync(file, text)
      expect(validateDocument(file).diagnostics).toEqual(validateDraftText(text, file).diagnostics)
    }
    // Complete prose without a machine contract is not an implementation-ready document.
    expect(validateDraftText(good).diagnostics.map((item) => item.code)).toEqual([
      'SDD_CONTRACT_REQUIRED'
    ])
    const contract = (requirements: object[]) =>
      good +
      '\n<!-- sdd-contract:start -->\n```json\n' +
      JSON.stringify({ protocol: 'sdd-loop-delivery/v1', revision: 'v1', requirements }) +
      '\n```\n<!-- sdd-contract:end -->'
    const requirement = { id: 'XQ01', title: 'Deliver feature', kind: 'must-ship' }
    expect(validateDraftText(contract([requirement])).valid).toBe(true)
    const withExample =
      '~~~~markdown\n' + contract([requirement]) + '\n~~~~\n' + contract([requirement])
    expect(validateDraftText(withExample).valid).toBe(true)
    const invalidContract = contract([{ ...requirement, dependencies: ['XQ01'] }])
    writeFileSync(file, invalidContract)
    expect(validateDraftText(invalidContract).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'SDD_CONTRACT_INVALID',
          message: 'CONTRACT_DEPENDENCY_CYCLE'
        })
      ])
    )
    expect(validateDocument(file).diagnostics).toEqual(
      validateDraftText(invalidContract, file).diagnostics
    )
    expect(
      validateDraftText(
        good + '\n<!-- sdd-contract:start -->\n```json\n{bad}\n```\n<!-- sdd-contract:end -->'
      ).valid
    ).toBe(false)
    expect(validateDraftText('~~~md\n' + good + '~~~\n').valid).toBe(false)
    writeFileSync(file, 'Mention sdd-contract in prose\n')
    expect(validateDocument(file).valid).toBe(false)
    expect(readdirSync(root)).toEqual(['draft.md'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('numbered headings still satisfy the required design sections', () => {
  const sections = [
    '4.1 Breaking Changes',
    '4.2 New/Changed API & Typing',
    '4.3 New/Changed Entities & Tools',
    '5. Implementation Flow & Pseudocode',
    '6 Delivery & Verification'
  ]
  const text =
    '# Design\n\n' +
    sections.map((heading) => `## ${heading}\n\nConcrete design content.\n`).join('\n') +
    '\n<!-- sdd-contract:start -->\n```json\n' +
    JSON.stringify({
      protocol: 'sdd-loop-delivery/v1',
      revision: 'v1',
      requirements: [{ id: 'XQ01', title: 'Deliver feature', kind: 'must-ship' }]
    }) +
    '\n```\n<!-- sdd-contract:end -->'
  expect(validateDraftText(text).diagnostics).toEqual([])
  expect(
    validateDraftText(
      text.replace('4.2 New/Changed API & Typing', '4.2 API notes')
    ).diagnostics.map((item) => item.code)
  ).toEqual(['SDD_REQUIRED_SECTION_MISSING'])
})

test('design field labels written with a full-width colon bind like ASCII labels', () => {
  const fieldsBySection: Record<string, [string, string[]]> = {
    breaking_changes: [
      'Breaking Changes',
      ['Before', 'After', 'Consumers', 'Migration', 'Intermediate states', 'Recovery']
    ],
    api_typing: [
      'New/Changed API & Typing',
      ['Signatures', 'Inputs and outputs', 'Errors', 'Examples', 'Exports and consumers']
    ],
    entities_tools: [
      'New/Changed Entities & Tools',
      ['Changes', 'Owners', 'Lifecycle', 'Dependencies', 'Reuse evidence']
    ],
    implementation_flow: [
      'Implementation Flow & Pseudocode',
      ['Entry points', 'Ordered flow', 'Data and state', 'Step coverage']
    ],
    delivery_verification: [
      'Delivery & Verification',
      ['Batches and dependencies', 'Exit conditions', 'Acceptance', 'Executed probes']
    ]
  }
  const document = (colon: string) =>
    Object.values(fieldsBySection)
      .map(
        ([heading, names]) =>
          `## ${heading}\n\n**Applicability${colon}** APPLICABLE\n\n` +
          names.map((name) => `**${name}${colon}** 具体设计内容`).join('\n\n')
      )
      .join('\n\n')
  const contract = {
    implementation_logic: { paths: [] },
    design_detail: {
      protocol: 'design-detail/v1',
      sections: Object.fromEntries(
        Object.entries(fieldsBySection).map(([key, [heading]]) => [
          key,
          { document: 'self', heading }
        ])
      )
    }
  }
  for (const colon of [':', '：'])
    expect(() => resolveDesignDetail(contract, { self: document(colon) })).not.toThrow()
  expect(() =>
    resolveDesignDetail(contract, {
      self: document('：').replace('**Recovery：** 具体设计内容', '')
    })
  ).toThrow('DESIGN_DETAIL_FIELD_REQUIRED:Recovery')
})

import { assertContractReferences } from '../scripts/helpers/contract-references'
import { mkdirSync } from 'node:fs'

test('contract references resolve by kind inside the repository', () => {
  const root = mkdtempSync(join(tmpdir(), 'contract-references-'))
  try {
    mkdirSync(join(root, '.git'))
    mkdirSync(join(root, 'docs'))
    const sdd = join(root, 'docs', 'change.sdd.md')
    writeFileSync(sdd, '# change')
    const withReferences = (productContract: unknown, evidence: string[] = []) =>
      ({
        revision: 'v1',
        requirements: [],
        experience_contract: { product_contract: productContract },
        migration: { inventory_evidence: evidence }
      }) as never
    expect(() =>
      assertContractReferences(
        withReferences({ kind: 'document', paths: ['docs/owner.sdd.md'] }),
        sdd
      )
    ).toThrow('CONTRACT_REFERENCE_NOT_FOUND: docs/owner.sdd.md')
    writeFileSync(join(root, 'docs', 'owner.sdd.md'), '# owner')
    expect(() =>
      assertContractReferences(
        withReferences({ kind: 'document', paths: ['docs/owner.sdd.md'] }),
        sdd
      )
    ).not.toThrow()
    expect(() => assertContractReferences(withReferences({ kind: 'external' }), sdd)).toThrow(
      'CONTRACT_REFERENCE_INVALID'
    )
    expect(() =>
      assertContractReferences(
        withReferences('legacy prose owner', [
          'https://example.com/notes.md',
          'probe output kept in change.evidence.md#facts'
        ]),
        sdd
      )
    ).not.toThrow()
    expect(() =>
      assertContractReferences(withReferences(undefined, ['change.evidence.md#facts']), sdd)
    ).toThrow('CONTRACT_REFERENCE_NOT_FOUND')
    expect(() =>
      assertContractReferences(withReferences(undefined, ['change.evidence.md#facts']), sdd, [
        join(root, 'docs', 'change.evidence.md')
      ])
    ).not.toThrow()
    expect(() =>
      assertContractReferences(withReferences(undefined, ['../../../outside.md']), sdd)
    ).toThrow('CONTRACT_REFERENCE_ESCAPES_ROOT')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
