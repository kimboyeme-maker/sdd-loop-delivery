import { expect, test } from 'bun:test'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBootstrapProcesses } from '../scripts/controllers/bootstrap-process'
import { prepare } from '../scripts/controllers/prepare.controller'
import { prepareRecord } from '../scripts/controllers/prepare-record.controller'
import { testRun } from '../scripts/controllers/test-run.controller'
import { assertExecutionBindings } from '../scripts/helpers/execution-bindings'
import { contextDocumentPage } from '../scripts/services/context-document'
import { readContractDocument } from '../scripts/services/contract-document'
import { COORDINATOR, createNativeChain } from './fixtures/native-chain'

type Item = Record<string, unknown>

test('a prepared Architect measures packet checks early as information that verification never reuses', () => {
  const root = mkdtempSync(join(tmpdir(), 'prepared-run-'))
  // test-run binds argv to the declared method, so the command that moves the phase mid-run has to
  // be the method itself. Both paths it names are known before the chain exists.
  const sdd = join(root, 'task.md')
  const copy = join(root, 'prepared-copy')
  const transitionModule = join(import.meta.dir, '../scripts/controllers/transition.controller.ts')
  const measuringMethod = `${process.execPath} -e ${JSON.stringify(
    `const { transition } = await import(${JSON.stringify(transitionModule)}); transition(${JSON.stringify(sdd)}, 'coordinator', 'IMPLEMENTING', 'v1', 'OPERATOR_SELF_CHECK', 'coordinator'); await import(${JSON.stringify(join(copy, 'check.ts'))})`
  )}`
  const chain = createNativeChain(root, {
    packetIds: ['PC01'],
    acceptanceMethod: measuringMethod
  })
  const events = () =>
    readFileSync(chain.sdd + '.events.jsonl', 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Item)
  try {
    chain.setup()
    chain.admit()
    const operator = chain.readback('PC01')
    chain.advance('READBACK_APPROVED', 'IMPLEMENTING')
    const implementation = chain.implement(operator, 'export const value = 2;', 'PC01')

    // The eventual Architect prepares while the Operator still holds its lease.
    const granted = prepare(
      chain.sdd,
      'coordinator',
      'IMPLEMENTING',
      'v1',
      'architect',
      false,
      false,
      COORDINATOR
    )
    process.env.SDD_LOOP_AGENT_TOKEN_FILE = granted.capabilityFile
    cpSync(chain.workspace, copy, { recursive: true })
    const preparedRun = (argv: readonly string[]) =>
      testRun(
        chain.sdd,
        'architect',
        'architect',
        '',
        chain.phase(),
        'v1',
        ['YS01'],
        argv,
        copy,
        undefined,
        COORDINATOR,
        granted.preparedId
      )
    expect(() => preparedRun([process.execPath, 'check.ts'])).toThrow(
      'PREPARATION_READINESS_REQUIRED'
    )
    runBootstrapProcesses(chain.sdd, 'architect', chain.phase(), 'v1', granted.preparedId)
    const preparedPages = join(root, 'prepared-pages.json')
    writeFileSync(
      preparedPages,
      JSON.stringify(
        contextDocumentPage(
          chain.sdd,
          { role: 'architect', preparedId: granted.preparedId, agentId: 'architect' },
          0,
          65536
        )
      )
    )
    prepareRecord(
      chain.sdd,
      'architect',
      granted.preparedId,
      'context_ready',
      {
        summary: 'Prepared reading of the fixture value route and its check.',
        read_result: preparedPages
      },
      chain.phase(),
      'v1',
      COORDINATOR
    )
    const marker = join(root, 'ran.txt')
    // A journal awaiting recovery stops the command before it runs.
    writeFileSync(chain.sdd + '.transaction.json', '{}')
    expect(() => preparedRun(['sh', '-c', `touch ${marker}`])).toThrow(
      'CONTROL_TRANSACTION_PENDING'
    )
    expect(existsSync(marker)).toBe(false)
    rmSync(chain.sdd + '.transaction.json')
    // The Operator worktree, its subdirectories and aliases are never an Architect copy.
    symlinkSync(chain.workspace, join(root, 'alias'))
    for (const directory of [chain.workspace, join(chain.workspace, '.git'), join(root, 'alias')])
      expect(() =>
        testRun(
          chain.sdd,
          'architect',
          'architect',
          '',
          chain.phase(),
          'v1',
          ['YS01'],
          ['true'],
          directory,
          undefined,
          COORDINATOR,
          granted.preparedId
        )
      ).toThrow('TEST_RUN_ISOLATED_COPY_REQUIRED')
    // A copy that does not hold the candidate bytes is refused before it runs.
    writeFileSync(join(copy, chain.productFile), 'export const value = 3;')
    expect(() => preparedRun(['true'])).toThrow('TEST_RUN_COPY_DIVERGED')
    writeFileSync(join(copy, chain.productFile), 'export const value = 2;')
    // Ordinary phase advancement while the check runs keeps its result: the command itself moves
    // the delivery to OPERATOR_SELF_CHECK before the controller registers the measurement.
    const measured = preparedRun(['sh', '-c', measuringMethod])
    expect(chain.phase()).toBe('OPERATOR_SELF_CHECK')
    expect(measured.eventId).toStartWith('EVT-')
    expect(measured.outcome).toBe('PASS')

    const contract = readContractDocument(chain.sdd) as unknown as Item
    const admission = events().findLast((event) => event.type === 'contract_admission')!
      .payload as Item
    const definition = (contract.acceptance as Item[])[0]!
    const check = {
      acceptance_ids: ['YS01'],
      method: definition.method,
      oracle: definition.oracle,
      environment: definition.environment,
      packages: definition.packages,
      outcome: 'PASS',
      evidence: ['measured on an isolated copy'],
      test_run_event_id: measured.eventId,
      duration_seconds: measured.duration_seconds
    }
    const packetCheck = (checks: Item[]) =>
      prepareRecord(
        chain.sdd,
        'architect',
        granted.preparedId,
        'packet_check',
        {
          packet_id: 'PC01',
          implementation_event_id: implementation,
          isolated_copy: copy,
          checks
        },
        chain.phase(),
        'v1',
        COORDINATOR
      ).eventId
    // A prepared check cannot claim a result its measured run did not produce.
    expect(() => packetCheck([{ ...check, outcome: 'FAIL' }])).toThrow(
      'VERIFICATION_CHECK_MEASUREMENT_MISMATCH'
    )
    expect(packetCheck([check])).toStartWith('EVT-')
    // Round verification cannot carry that result over; it measures again under its own lease.
    const verification = {
      ...chain.verificationPayload(),
      checks: [{ ...check, execution: 'REUSED', replayability: 'IMMUTABLE_LOCAL' }]
    }
    expect(() =>
      assertExecutionBindings(
        chain.state(),
        contract,
        { lease_id: 'formal' },
        verification,
        events(),
        admission
      )
    ).toThrow('VERIFICATION_EXECUTION_MODE_INVALID')
    // A later failing observation of the same acceptance supersedes an executed PASS.
    const later = {
      event_id: 'EVT-later',
      type: 'test_run',
      role: 'operator',
      payload: { acceptance_ids: ['YS01'], outcome: 'FAIL' }
    }
    expect(() =>
      assertExecutionBindings(
        chain.state(),
        contract,
        { lease_id: granted.preparedId },
        { checks: [check] },
        [...events(), later],
        admission
      )
    ).toThrow()
  } finally {
    chain.restore()
    rmSync(root, { recursive: true, force: true })
  }
})
