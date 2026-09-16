import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eventLogBinding } from '../scripts/resource/store/event-log-binding'
import { assertFindingProposal } from '../scripts/controllers/record.controller'
import { retrospective } from '../scripts/services/retrospective'

type Item = Record<string, unknown>

const finding = (patch: Item = {}) => ({
  event_id: 'EVT-F1',
  role: 'coordinator',
  type: 'finding_proposal',
  payload: {
    target_skill: 'create-sdd',
    proposal_key: 'zero-match-acceptance-passes',
    defect: 'An acceptance passes on a tree where its own case does not exist.',
    consequence: 'Deleting the case restores a green result, so the case guards nothing.',
    evidence: ['EVT-b968e118 recorded PASS before any implementation existed'],
    disposition: 'DOCUMENTED',
    area: 'references/product/acceptance-standards.md',
    remedy: 'Require the method to assert what it observed rather than its exit code.',
    ...patch
  }
})

/** A terminal delivery whose only recorded issue is the finding under test. */
function delivery(events: Item[]): { sdd: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'finding-proposal-'))
  const sdd = join(root, 'feature.sdd.md')
  const text = events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '')
  const bytes = Buffer.from(text)
  writeFileSync(sdd, '# Feature\n')
  writeFileSync(`${sdd}.events.jsonl`, bytes)
  writeFileSync(
    `${sdd}.loop.json`,
    JSON.stringify({
      protocol: 'control-plane/state-v2',
      sdd,
      phase: 'SHIP',
      contract_revision: 'v1',
      revision: 2,
      authority_epoch: 1,
      logical_round: 1,
      max_rounds: 3,
      completed_attempts: 1,
      issued_leases: {},
      event_log: eventLogBinding(bytes)
    })
  )
  return { sdd, root }
}

test('a recorded finding reaches the retrospective as its own issue and proposal', () => {
  const { sdd, root } = delivery([finding()])
  try {
    const report = retrospective(sdd) as Item
    const issues = report.issues as Item[]
    const proposals = report.proposals as Item[]
    // Before this channel existed, seven findings recorded in a real delivery produced zero issues:
    // the retrospective only ever saw counters and rejection codes.
    const issue = issues.find((item) => item.kind === 'SKILL_FINDING')
    expect(issue).toBeDefined()
    expect(issue!.key).toBe('zero-match-acceptance-passes')
    expect(issue!.severity).toBe('high')
    expect(issue!.evidence_event_ids).toEqual(['EVT-F1'])
    // The finding names its own target and remedy; the playbook supplies neither.
    const proposal = proposals.find((item) => (item.issue_ids as string[])[0] === issue!.id)!
    expect(proposal.target).toBe('create-sdd')
    expect(proposal.area).toBe('references/product/acceptance-standards.md')
    expect(proposal.change).toContain('assert what it observed')
    // The key is what lets the same finding mature across deliveries.
    expect(proposal.key).toBe('create-sdd:SKILL_FINDING:zero-match-acceptance-passes')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a finding already fixed in this delivery is recorded rather than proposed again', () => {
  const { sdd, root } = delivery([finding({ disposition: 'FIXED' })])
  try {
    const issues = (retrospective(sdd) as Item).issues as Item[]
    expect(issues.find((item) => item.kind === 'SKILL_FINDING')!.severity).toBe('low')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the recorded shape is enforced, so a finding cannot become a prose dump', () => {
  const reject = (patch: Item) =>
    expect(() => assertFindingProposal(finding(patch).payload)).toThrow('FINDING_PROPOSAL_INVALID')
  expect(() => assertFindingProposal(finding().payload)).not.toThrow()
  // A target outside the three things this loop can change is not this loop's business.
  reject({ target_skill: 'some-other-repo' })
  // A key that is a sentence cannot be counted across deliveries, which is the point of a key.
  reject({ proposal_key: 'the acceptance passes on nothing' })
  reject({ evidence: [] })
  reject({ consequence: '   ' })
  reject({ disposition: 'PROBABLY' })
})
