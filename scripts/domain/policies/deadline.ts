/** A deadline is exclusive; non-finite clocks or deadlines cannot grant authority. */
export function isBeforeDeadline(now: number, deadline: number): boolean {
  return Number.isFinite(now) && Number.isFinite(deadline) && now < deadline
}
