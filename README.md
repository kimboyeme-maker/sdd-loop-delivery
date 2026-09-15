# sdd-loop-delivery

Bun/TypeScript skill that executes a loop-ready SDD with a read-only Supervisor, a resident Coordinator, Operator implementation and independent Architect verification.

## Use

```text
$sdd-loop-delivery docs/feature.sdd.md [max_rounds]
```

[SKILL.md](SKILL.md) is normative. Role references live in [references/](references/). For people: [HUMAN.md](HUMAN.md) explains the whole flow; the [runbook](references/runbook.md) covers stuck deliveries. Users never pick role models or run controller commands; the Supervisor spawns the Coordinator.

## Controller

```bash
bun scripts/main.ts --help
bun scripts/main.ts status --sdd /absolute/path/to/task.sdd.md --compact
bun scripts/main.ts capabilities
cat candidate.sdd.md | bun scripts/main.ts validate-draft
```

The CLI never installs dependencies, edits the SDD, takes over authority or creates agents. Authority-bearing mutations authenticate, lock and commit state and signed events atomically.

## Maintenance

```bash
bun run review:release          # tests, format, lint, types, command coverage, CLI chain, generated references, behavior cases
bun run render:configuration    # regenerate configuration.md from roles.json and constants
bun run render:errors           # regenerate references/error-codes.md
bun run behavior:plan           # dry-run Bad/Good behavior matrix; never starts agents
```

Release review covers automated checks only; it does not prove host agent behavior or production readiness.
