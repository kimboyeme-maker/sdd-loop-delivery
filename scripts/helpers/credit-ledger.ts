import { CREDIT_WEIGHTS } from '../config/constants'

type Item = Record<string, unknown>

/** Persisted credit ledger; `budget` and `spent` are relative units, never billed tokens. */
export type CreditLedger = Readonly<{
  protocol: 'credit-ledger/v1'
  budget: number
  spent: number
  /** `observe` records spend and reports overruns; `enforce` blocks new grants at the budget. */
  mode?: 'observe' | 'enforce'
}>

/** Read the ledger. States initialized before the ledger existed carry none and are not charged. */
export function creditLedger(state: Item): CreditLedger | null {
  const ledger = state.credit_ledger
  if (ledger === undefined || ledger === null) return null
  const value = ledger as Item
  if (
    typeof ledger !== 'object' ||
    value.protocol !== 'credit-ledger/v1' ||
    !Number.isSafeInteger(value.budget) ||
    !Number.isSafeInteger(value.spent) ||
    Number(value.budget) < 0 ||
    Number(value.spent) < 0 ||
    (value.mode !== undefined && value.mode !== 'observe' && value.mode !== 'enforce')
  )
    throw new Error('CREDIT_LEDGER_INVALID')
  return value as CreditLedger
}

/** Units for one named grant kind from the configured weights. */
export function creditWeight(kind: string): number {
  const weight = CREDIT_WEIGHTS[kind]
  if (!Number.isSafeInteger(weight) || Number(weight) < 0) throw new Error('CREDIT_WEIGHT_UNKNOWN')
  return Number(weight)
}

/**
 * Charge units before the grant commits. In `enforce` mode an exhausted budget stops new spend and
 * routes to an explicit user decision (`user-control --action extend-credit`), never to BLOCKED or a retry.
 * Returns the next ledger, or undefined when the state carries none.
 */
export function chargeCredit(
  state: Item,
  units: number,
  options: Readonly<{ allowOverrun?: boolean }> = {}
): CreditLedger | undefined {
  const ledger = creditLedger(state)
  if (!ledger) return undefined
  if (!Number.isSafeInteger(units) || units < 0) throw new Error('CREDIT_UNITS_INVALID')
  // Work already performed (a finished test run) is recorded even if it overran the budget;
  // the next grant then stops on the exhausted ledger.
  const enforce = ledger.mode === 'enforce'
  if (enforce && ledger.spent + units > ledger.budget && !options.allowOverrun)
    throw new Error(
      `CREDIT_BUDGET_EXHAUSTED: ${ledger.spent}+${units}>${ledger.budget}; request user-control extend-credit`
    )
  return { ...ledger, spent: ledger.spent + units }
}
