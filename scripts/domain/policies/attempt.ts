export type AttemptState = Readonly<{
  completed: number
  failures: number
}>

export type AttemptEvent = 'continuation' | 'progress' | 'product-failure'

/** Product attempts change only for a real product failure, never for a reply boundary. */
export function applyAttemptEvent(state: AttemptState, event: AttemptEvent): AttemptState {
  if (!Number.isInteger(state.completed) || state.completed < 0)
    throw new Error('ATTEMPT_STATE_INVALID')
  if (!Number.isInteger(state.failures) || state.failures < 0)
    throw new Error('ATTEMPT_STATE_INVALID')
  if (event === 'product-failure')
    return Object.freeze({ completed: state.completed, failures: state.failures + 1 })
  return Object.freeze({ ...state })
}
