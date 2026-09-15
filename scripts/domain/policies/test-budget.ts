import {
  MAX_NEW_TEST_FILES_PER_BATCH,
  TEST_BUDGET_MAX_MINUTES,
  TEST_BUDGET_MAX_SHARE_DIVISOR
} from '../../config/constants'

export type TestBudget = Readonly<{ minutes: number; max_new_test_files: number }>

/**
 * Validate finite declared limits. Exceeding the default time/share/file thresholds needs
 * a rationale bound to this batch's acceptance; runtime limits still use the declared values.
 */
export function assertTestBudget(
  value: unknown,
  prefix: string,
  estimatedMinutes?: number,
  acceptanceIds?: readonly string[]
): TestBudget {
  const budget =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  if (
    !budget ||
    !Number.isSafeInteger(budget.minutes) ||
    Number(budget.minutes) < 0 ||
    !Number.isSafeInteger(budget.max_new_test_files) ||
    Number(budget.max_new_test_files) < 0
  )
    throw new Error(`${prefix}_TEST_BUDGET_INVALID`)
  const cap =
    estimatedMinutes === undefined
      ? TEST_BUDGET_MAX_MINUTES
      : Math.min(
          TEST_BUDGET_MAX_MINUTES,
          Math.ceil(estimatedMinutes / TEST_BUDGET_MAX_SHARE_DIVISOR)
        )
  if (
    Number(budget.minutes) > cap ||
    Number(budget.max_new_test_files) > MAX_NEW_TEST_FILES_PER_BATCH
  ) {
    const basis = budget.acceptance_basis as Record<string, unknown> | undefined
    if (
      !basis ||
      typeof basis.reason !== 'string' ||
      !basis.reason.trim() ||
      !Array.isArray(basis.acceptance_ids) ||
      !basis.acceptance_ids.length ||
      !acceptanceIds ||
      basis.acceptance_ids.some((id) => typeof id !== 'string' || !acceptanceIds.includes(id))
    )
      throw new Error(`${prefix}_TEST_BUDGET_JUSTIFICATION_REQUIRED`)
  }
  return { minutes: Number(budget.minutes), max_new_test_files: Number(budget.max_new_test_files) }
}
