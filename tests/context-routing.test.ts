import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contextRouting } from '../scripts/helpers/context-routing'

/** A throwaway document tree; the callback receives the root SDD path and its directory. */
function withDocuments(
  files: Record<string, string>,
  action: (sdd: string, dir: string) => void
): void {
  const dir = mkdtempSync(join(tmpdir(), 'context-routing-'))
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
    action(join(dir, 'task.sdd.md'), dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const companion = '## Shared\n\n### Evidence\n@./task.evidence.md\n'
const evidence = '# Evidence\n\nProbe records.\n'

test('the root entry is honored at any heading level', () => {
  for (const heading of ['## Agent Context', '### Agent Context', '#### Agent Context']) {
    withDocuments(
      {
        'task.sdd.md': `# Task\n\n## 0. Status\n\n${heading}\n\n@./task.agent-context.md\n\n### Authoring receipt\n\n- \`references/loading.md\` aaaaaaaa\n`,
        'task.agent-context.md': companion,
        'task.evidence.md': evidence
      },
      (sdd) => {
        const routing = contextRouting(
          sdd,
          require('node:fs').readFileSync(sdd, 'utf8'),
          'coordinator'
        )
        expect(routing.map).toContain('task.agent-context.md')
        expect(routing.sources.map((source) => source.path.split('/').pop())).toContain(
          'task.evidence.md'
        )
      }
    )
  }
})

test('a document without the entry routes only itself', () => {
  withDocuments({ 'task.sdd.md': '# Task\n\nProse only.\n' }, (sdd) => {
    const routing = contextRouting(sdd, '# Task\n\nProse only.\n', 'coordinator')
    expect(routing.map).toBeNull()
    expect(routing.sources).toHaveLength(1)
  })
})

test('two root entries are ambiguous and a pointer outside the tree is rejected', () => {
  const twice =
    '# Task\n\n## Agent Context\n\n@./task.agent-context.md\n\n## Agent Context\n\n@./task.agent-context.md\n'
  withDocuments(
    { 'task.sdd.md': twice, 'task.agent-context.md': companion, 'task.evidence.md': evidence },
    (sdd) => {
      expect(() => contextRouting(sdd, twice, 'coordinator')).toThrow(
        'AGENT_CONTEXT_ENTRY_AMBIGUOUS'
      )
    }
  )
  const missing = '# Task\n\n## Agent Context\n\n@./absent.md\n'
  withDocuments({ 'task.sdd.md': missing }, (sdd) => {
    expect(() => contextRouting(sdd, missing, 'coordinator')).toThrow(
      'AGENT_CONTEXT_LINK_NOT_FOUND'
    )
  })
})

test('an entry that is not exactly one pointer is rejected', () => {
  const prose =
    '# Task\n\n## Agent Context\n\nThis block explains the routing instead of declaring it.\n'
  withDocuments({ 'task.sdd.md': prose }, (sdd) => {
    expect(() => contextRouting(sdd, prose, 'coordinator')).toThrow('AGENT_CONTEXT_ENTRY_INVALID')
  })
})
