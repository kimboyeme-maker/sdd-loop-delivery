export type ProcessObservation = Readonly<{
  processId: string
  running: boolean
  source: 'host-receipt' | 'controller-observation'
}>

/** Host facts are passed in; this layer never claims to inspect or close a process. */
export function observeProcess(input: ProcessObservation): ProcessObservation {
  if (!input.processId.trim()) throw new Error('PROCESS_ID_REQUIRED')
  return Object.freeze({ ...input })
}
