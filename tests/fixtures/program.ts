import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { admissionFixture } from './admission'

/** One leaf contract: the admission fixture plus a single-batch delivery plan in its own package. */
export function leafContract(pkg: string) {
  const { contract } = admissionFixture(pkg)
  return {
    ...contract,
    delivery_plan: {
      protocol: 'delivery-plan/v1',
      batches: [
        {
          id: 'BT01',
          lane: 'main',
          requirement_ids: ['XQ01'],
          acceptance_ids: ['YS01'],
          modification_packages: [pkg],
          estimated_minutes: 30,
          test_budget: { minutes: 5, max_new_test_files: 1 }
        }
      ]
    }
  }
}

/** The leaf SDD text: its contract plus the required design sections. */
function leaf(pkg: string): string {
  const withPlan = leafContract(pkg)
  const sections = [
    'Breaking Changes',
    'New/Changed API & Typing',
    'New/Changed Entities & Tools',
    'Implementation Flow & Pseudocode',
    'Delivery & Verification'
  ]
    .map((title) => `## ${title}\nUse the existing isolated value producer; no public API changes.\n`)
    .join('\n')
  return `# ${pkg}\n\n<!-- sdd-contract:start -->\n\`\`\`json\n${JSON.stringify(withPlan)}\n\`\`\`\n<!-- sdd-contract:end -->\n${sections}`
}

const estimate = (design: [number, number], work: [number, number]) => ({
  design,
  implementation: work,
  integration: [0, 0],
  verification: work,
  conditional_verification: [0, 0],
  basis: 'fixture batches',
  waiting: 'none'
})

const validator = (owner: string, acceptance_ids: string[]) => ({
  definition: 'program-structure/v1',
  implementation: { owner, acceptance_ids, method: 'fixture-check', pass_condition: 'value' }
})

/** Metas for one execution node; `requires` lists Asset ids produced elsewhere. */
function execution(node: string, file: string, requires: string[]) {
  const id = node.toUpperCase()
  return [
    {
      id: `M${id}`,
      kind: 'Module',
      owner: node,
      members: [],
      requires: [],
      source_id: 'XQ01',
      origin: { document: file, requirement_id: 'XQ01' },
      validators: validator(node, ['YS01'])
    },
    {
      id: `C${id}`,
      kind: 'Chunk',
      owner: node,
      members: [`M${id}`],
      requires: [],
      source_id: 'BT01',
      validators: validator(node, ['YS01'])
    },
    {
      id: `B${id}`,
      kind: 'Bundle',
      owner: node,
      members: [`C${id}`],
      requires,
      reads: [],
      validators: validator(node, ['YS01'])
    },
    {
      id: `A${id}`,
      kind: 'Asset',
      owner: node,
      members: [],
      requires: [],
      path: `packages/${node}/value.ts`,
      validators: validator(node, ['YS01'])
    }
  ]
}

/**
 * A committed two-Bundle program in `root`: producer `a`, consumer `b` requiring a's Asset.
 * Returns the root SDD path. Synthetic structure only; no child delivery runs.
 */
export function programFixture(root: string): string {
  Bun.spawnSync(['git', 'init', '-q', root])
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'docs/a.sdd.md'), leaf('packages/a'))
  writeFileSync(join(root, 'docs/b.sdd.md'), leaf('packages/b'))
  // The product each child changes, with the real check its acceptance runs.
  for (const node of ['a', 'b']) {
    mkdirSync(join(root, 'packages', node), { recursive: true })
    writeFileSync(join(root, 'packages', node, 'value.ts'), 'export const value = 1;')
    writeFileSync(
      join(root, 'packages', node, 'check.ts'),
      "import {value} from './value'; if (value !== 2) throw Error('wrong value');"
    )
  }
  const program = {
    protocol: 'sdd-program/v1',
    id: 'PG01',
    revision: 'r1',
    nodes: [
      { id: 'root', parent: null, kind: 'group', sdd: 'root.sdd.md', estimate: estimate([5, 10], [0, 0]) },
      { id: 'a', parent: 'root', kind: 'execution', sdd: 'a.sdd.md', estimate: estimate([5, 10], [30, 45]) },
      { id: 'b', parent: 'root', kind: 'execution', sdd: 'b.sdd.md', estimate: estimate([5, 10], [30, 45]) }
    ],
    metas: [
      {
        id: 'EN01',
        kind: 'Entry',
        owner: 'root',
        members: ['MA', 'MB'],
        requires: [],
        validators: validator('root', [])
      },
      ...execution('a', 'a.sdd.md', []),
      ...execution('b', 'b.sdd.md', ['AA'])
    ],
    execution: {
      max_parallel: 2,
      total_test_seconds: 200,
      base_ref: 'HEAD',
      allocations: { BA: 150, BB: 50 }
    },
    split_decision: { source: 'USER_STATED', reference: 'fixture instruction to split' }
  }
  const path = join(root, 'docs/root.sdd.md')
  writeFileSync(
    path,
    `# Program\n\n<!-- sdd-program:start -->\n\`\`\`json\n${JSON.stringify(program)}\n\`\`\`\n<!-- sdd-program:end -->\n`
  )
  const git = (...args: string[]) =>
    Bun.spawnSync(['git', '-C', root, '-c', 'user.name=fixture', '-c', 'user.email=f@x', ...args])
  git('add', '.')
  git('commit', '-qm', 'fixture')
  return path
}
