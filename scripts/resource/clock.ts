/** Injectable clock boundary used by lease and deadline checks. */
export type Clock = Readonly<{ now: () => number }>

export const systemClock: Clock = Object.freeze({ now: () => Date.now() })
