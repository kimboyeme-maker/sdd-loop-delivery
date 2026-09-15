#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

type Item = Record<string, unknown>
const PROTOCOL = 'skill-behavior-cases/v1'
/** Evidence maturity: report → trace → repro → paired-eval (only the last supports effect claims). */
const EVIDENCE_LEVELS = ['report', 'trace', 'repro', 'paired-eval']
const DECISIONS = ['ALLOW', 'REJECT', 'DEFER', 'REQUIRE_USER']
const ARMS = ['stable', 'candidate-skill', 'candidate-full'] as const
const VARIANTS = ['bad', 'good'] as const
const PAIR_FIELDS = [
  'task_mode',
  'request',
  'starting_state',
  'material_action',
  'expected_decision',
  'decisive_fact',
  'completion_oracle'
] as const

const text = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

/** Validate one Bad or Good arm without executing its acceptance oracle. */
function variant(caseId: string, name: string, value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${caseId}.${name} must be an object`)
  const result = Object.fromEntries(
    PAIR_FIELDS.map((field) => [field, text((value as Item)[field], `${caseId}.${name}.${field}`)])
  )
  if (!DECISIONS.includes(result.expected_decision!))
    throw new Error(`${caseId}.${name}.expected_decision must be one of ${DECISIONS.join(', ')}`)
  return result
}

/** Validate a minimal-contrast suite: each pair reverses the decision by changing one decisive fact. */
export function validateSuite(value: unknown, source: string): Item {
  const suite = value as Item
  if (!suite || suite.protocol !== PROTOCOL) throw new Error(`${source}: unsupported protocol`)
  if (!Array.isArray(suite.cases) || !suite.cases.length)
    throw new Error(`${source}: cases must be a non-empty list`)
  const seen = new Set<string>()
  const cases = suite.cases.map((raw: Item) => {
    const id = text(raw?.id, `${source}.case.id`)
    if (seen.has(id)) throw new Error(`${source}: duplicate case id ${id}`)
    seen.add(id)
    const level = text(raw.evidence_level, `${id}.evidence_level`)
    if (!EVIDENCE_LEVELS.includes(level)) throw new Error(`${id}: unsupported evidence level`)
    const bad = variant(id, 'bad', raw.bad),
      good = variant(id, 'good', raw.good)
    if (bad.expected_decision === good.expected_decision)
      throw new Error(`${id}: Bad and Good decisions must reverse`)
    if (bad.decisive_fact === good.decisive_fact)
      throw new Error(`${id}: pair must change its decisive fact`)
    return {
      id,
      title: text(raw.title, `${id}.title`),
      skill: text(raw.skill, `${id}.skill`),
      evidence_level: level,
      single_changed_fact: text(raw.single_changed_fact, `${id}.single_changed_fact`),
      bad,
      good
    }
  })
  return { protocol: PROTOCOL, suite: text(suite.suite, `${source}.suite`), cases }
}

/** Build deterministic dry-run cells; this never starts agents or spends credits. */
export function buildPlan(suites: readonly Item[], runs: number): Item {
  if (!Number.isInteger(runs) || runs < 1 || runs > 10)
    throw new Error('runs must be between 1 and 10')
  const ids = new Set<string>()
  const cells: Item[] = []
  for (const suite of suites)
    for (const entry of suite.cases as Item[]) {
      const id = String(entry.id)
      if (ids.has(id)) throw new Error(`duplicate case id across suites: ${id}`)
      ids.add(id)
      for (const name of VARIANTS)
        for (const arm of ARMS)
          for (let run = 1; run <= runs; run++) {
            const pair = entry[name] as Record<string, string>
            cells.push({
              suite: suite.suite,
              case_id: id,
              variant: name,
              arm,
              run,
              expected_decision: pair.expected_decision,
              completion_oracle: pair.completion_oracle
            })
          }
    }
  return {
    protocol: 'skill-behavior-eval-plan/v1',
    dry_run: true,
    arms: [...ARMS],
    runs_per_arm: runs,
    case_count: ids.size,
    cell_count: cells.length,
    cells,
    claim_gate: {
      all_good_cases_must_complete: true,
      retain_negative_null_and_infrastructure_results: true,
      no_effectiveness_claim_from_plan_or_single_run: true
    }
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const suites: string[] = []
  let runs = 3
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--suite' && args[index + 1]) suites.push(args[++index]!)
    else if (args[index] === '--runs' && args[index + 1]) runs = Number(args[++index])
    else {
      console.error(`UNKNOWN_ARGUMENT: ${args[index]}`)
      process.exit(2)
    }
  }
  try {
    const paths = suites.length
      ? suites
      : [join(import.meta.dir, '..', 'cases', 'behavior-cases.json')]
    const plan = buildPlan(
      paths.map((path) => validateSuite(JSON.parse(readFileSync(path, 'utf8')), path)),
      runs
    )
    console.log(JSON.stringify(plan, null, 2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
}
