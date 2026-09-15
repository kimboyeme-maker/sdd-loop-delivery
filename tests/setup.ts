import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Rejection diagnostics from tests go to a disposable directory, never the user cache.
process.env.SDD_LOOP_DIAGNOSTICS_DIR ??= mkdtempSync(join(tmpdir(), 'sdd-loop-diagnostics-'))
