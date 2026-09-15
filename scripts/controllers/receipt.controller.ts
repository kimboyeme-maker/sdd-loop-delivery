import { assertRoleReceipt } from '../schemas/role-receipt'
import { assertCandidateBinding } from '../helpers/candidate-evidence'
import { readFileSync } from 'node:fs'
import { workspacePath } from '../utils/workspace-path'

export type ReceiptLintResult = Readonly<{
  protocol: 'operator-receipt-lint/v1'
  receipt: string
  valid: boolean
  diagnostics: readonly { code: string; message: string }[]
}>

/** Validate receipt shape only; product state and candidate acceptance remain separate gates. */
export function lintOperatorReceipt(path: string, type?: string): ReceiptLintResult {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    const diagnostics = [{ code: 'RECEIPT_JSON_INVALID', message: 'receipt must be valid JSON' }]
    return { protocol: 'operator-receipt-lint/v1', receipt: path, valid: false, diagnostics }
  }
  if (type !== undefined) {
    const diagnostics: { code: string; message: string }[] = []
    try {
      if (
        ![
          'implementation',
          'self_check',
          'contract_readback',
          'checkpoint',
          'implementation_escalation'
        ].includes(type)
      )
        throw Error('OPERATOR_RECEIPT_TYPE_INVALID')
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw Error('EVENT_PAYLOAD_MUST_BE_OBJECT')
      const payload = value as Record<string, unknown>
      assertRoleReceipt(type, payload)
      if (type === 'implementation') {
        if (
          !payload.candidate ||
          typeof payload.candidate !== 'object' ||
          Array.isArray(payload.candidate)
        )
          throw Error('CANDIDATE_INVALID')
        const candidate = payload.candidate as Record<string, unknown>
        assertCandidateBinding(candidate, candidate)
        if (!Array.isArray(payload.test_changes))
          throw Error('IMPLEMENTATION_TEST_CHANGES_REQUIRED')
      }
    } catch (error) {
      diagnostics.push({
        code: 'ROLE_RECEIPT_SCHEMA_INVALID',
        message: error instanceof Error ? error.message : 'Invalid role receipt'
      })
    }
    return {
      protocol: 'operator-receipt-lint/v1',
      receipt: path,
      valid: diagnostics.length === 0,
      diagnostics
    }
  }
  return lintReceiptValue(value, path)
}

/** Check the same parsed snapshot that the caller will consume; never reopen its source. */
function lintReceiptValue(value: unknown, path: string): ReceiptLintResult {
  const diagnostics: { code: string; message: string }[] = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    diagnostics.push({ code: 'RECEIPT_OBJECT_REQUIRED', message: 'receipt must be an object' })
  } else {
    const record = value as Record<string, unknown>
    for (const field of ['agent_id', 'lease_id', 'status']) {
      if (typeof record[field] !== 'string' || !record[field])
        diagnostics.push({ code: 'RECEIPT_FIELD_REQUIRED', message: `${field} is required` })
    }
    if (record.role !== 'Operator')
      diagnostics.push({ code: 'RECEIPT_ROLE_INVALID', message: 'role must be Operator' })
    if (!Array.isArray(record.changes)) {
      diagnostics.push({
        code: 'RECEIPT_MANIFEST_REQUIRED',
        message: 'changes manifest is required'
      })
    } else {
      if (record.changes.length === 0)
        diagnostics.push({
          code: 'RECEIPT_MANIFEST_EMPTY',
          message: 'changes manifest cannot be empty'
        })
      record.changes.forEach((change, index) => {
        if (!change || typeof change !== 'object' || Array.isArray(change)) {
          diagnostics.push({
            code: 'RECEIPT_CHANGE_INVALID',
            message: `changes[${index}] must be an object`
          })
          return
        }
        const item = change as Record<string, unknown>
        if (typeof item.path !== 'string' || !item.path)
          diagnostics.push({
            code: 'RECEIPT_CHANGE_PATH_REQUIRED',
            message: `changes[${index}].path is required`
          })
        const paths = [item.path, item.from_path, item.to_path].filter(
          (value): value is string => typeof value === 'string'
        )
        if (
          paths.some((value) => {
            try {
              workspacePath(value)
              return false
            } catch {
              return true
            }
          })
        )
          diagnostics.push({
            code: 'RECEIPT_CHANGE_PATH_UNSAFE',
            message: `changes[${index}] paths must be relative and stay within the workspace`
          })
        const action = String(item.action)
        if (!['CREATED', 'MODIFIED', 'DELETED', 'RENAMED'].includes(action))
          diagnostics.push({
            code: 'RECEIPT_CHANGE_ACTION_INVALID',
            message: `changes[${index}].action is invalid`
          })
        if (action === 'RENAMED') {
          if (typeof item.from_path !== 'string' || !item.from_path)
            diagnostics.push({
              code: 'RECEIPT_RENAME_SOURCE_REQUIRED',
              message: `changes[${index}].from_path is required for RENAMED`
            })
          if (typeof item.to_path !== 'string' || !item.to_path)
            diagnostics.push({
              code: 'RECEIPT_RENAME_TARGET_REQUIRED',
              message: `changes[${index}].to_path is required for RENAMED`
            })
          if (typeof item.from_path === 'string' && item.from_path === item.to_path)
            diagnostics.push({
              code: 'RECEIPT_RENAME_PATHS_EQUAL',
              message: `changes[${index}] rename paths must differ`
            })
        }
      })
    }
  }
  return {
    protocol: 'operator-receipt-lint/v1',
    receipt: path,
    valid: diagnostics.length === 0,
    diagnostics
  }
}

/** Emit field structure only. Empty values require actual role observations before submission. */
export function scaffoldOperatorReceipt(
  agentId: string,
  leaseId: string,
  type?: string
): Readonly<Record<string, unknown>> {
  if (!agentId || !leaseId) throw new Error('RECEIPT_BINDING_REQUIRED')
  if (type !== undefined) {
    const ownership = { semantic_ids: [], evidence: [], unresolved_conflicts: [] }
    const binding = {
      candidate_id: '',
      environment_fingerprint: '',
      manifest_sha256: '',
      worktree_fingerprint: ''
    }
    const identity = { agent_id: agentId, lease_id: leaseId }
    if (type === 'implementation')
      return {
        ...identity,
        execution_packet_ids: [],
        changed_packages: [],
        test_changes: [],
        candidate: { ...binding, changes: [] }
      }
    if (type === 'contract_readback')
      return {
        ...identity,
        assessment: null,
        route_assessment: null,
        independent_checks: [],
        unresolved_unknowns: [],
        execution_packet_ids: [],
        semantic_ownership_review: ownership
      }
    if (type === 'self_check')
      return {
        ...identity,
        ...binding,
        result: null,
        handoff_status: null,
        execution_packet_ids: [],
        semantic_ownership_review: ownership,
        candidate_receipt: {
          oracle_sensitivity: { status: null, acceptance_ids: [], evidence: [] },
          environment_integrity: {
            status: null,
            before_fingerprint: '',
            after_fingerprint: '',
            unexpected_drift: [],
            evidence: []
          },
          modification_scope: {
            status: null,
            changed_packages: [],
            changed_paths: [],
            unauthorized_changes: [],
            evidence: []
          }
        }
      }
    throw Error('OPERATOR_RECEIPT_SCAFFOLD_TYPE_INVALID')
  }
  return {
    protocol: 'operator-receipt/v1',
    role: 'Operator',
    agent_id: agentId,
    lease_id: leaseId,
    status: 'partial',
    changes: [],
    checks: [],
    findings: []
  }
}
