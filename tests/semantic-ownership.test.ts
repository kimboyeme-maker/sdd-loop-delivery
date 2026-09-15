import { expect, test } from 'bun:test'
import { semanticName } from '../scripts/utils/semantic-name'
import { assertSemanticOwnership } from '../scripts/domain/policies/semantic-ownership'

test('semantic names ignore case, width and surrounding whitespace', () => {
  expect(semanticName('  Straße ')).toBe(semanticName('STRASSE'))
  expect(semanticName('Σςσ')).toBe(semanticName('σσσ'))
  expect(semanticName('ＯＷＮＥＲ')).toBe(semanticName('owner'))
  expect(semanticName('\towner\n')).toBe('owner')
})
test('ownership rejects duplicate subjects and authorities while allowing distinct subjects and shared observers', () => {
  const observer = {
    name: 'observer',
    role: 'OBSERVER',
    relationship: 'reads state',
    evidence: 'read-only consumer'
  }
  const item = {
    id: 'SO01',
    subject: 'Straße',
    authoritative_owner: 'Handler',
    requirement_ids: ['XQ01'],
    evidence: ['source'],
    participants: [observer]
  }
  const ownership = {
    items: [item],
    cross_clause_evidence: ['contract matches owner'],
    primitive_search_evidence: ['reuse handler'],
    primitive_decisions: [
      {
        disposition: 'REUSE',
        need: 'terminal state',
        target: 'handler',
        evidence: 'existing owner'
      }
    ],
    unresolved_conflicts: []
  }
  const check = (value: unknown) =>
    assertSemanticOwnership({ requirement_ids: ['XQ01'], semantic_ownership: value })
  expect(() => check(ownership)).not.toThrow()
  expect(() =>
    check({ ...ownership, items: [item, { ...item, id: 'SO02', subject: 'Other' }] })
  ).not.toThrow()
  for (const bad of [
    { ...ownership, items: [item, { ...item, id: 'SO02', subject: ' STRASSE ' }] },
    { ...ownership, items: [{ ...item, participants: [{ ...observer, name: 'HANDLER' }] }] },
    {
      ...ownership,
      items: [{ ...item, participants: [observer, { ...observer, name: 'Observer' }] }]
    },
    { ...ownership, unresolved_conflicts: ['owner undecided'] },
    { ...ownership, items: [{ ...item, requirement_ids: ['XQ99'] }] },
    {
      ...ownership,
      primitive_decisions: [
        { disposition: 'NEW_JUSTIFIED', need: 'state', target: 'new module', evidence: '' }
      ]
    }
  ])
    expect(() => check(bad)).toThrow()
})
