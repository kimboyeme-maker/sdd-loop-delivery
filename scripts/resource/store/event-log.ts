import { existsSync, readFileSync } from 'node:fs'

type Event = Record<string, unknown>
let parsedText: string | undefined
let parsedEvents: Event[] = []

/**
 * Parse JSON-lines event text once per distinct text. A command reads the log once and consults it
 * from many rules, which all share the same frozen array.
 */
export function parseEvents(text: string | Buffer): Event[] {
  const value = typeof text === 'string' ? text : text.toString('utf8')
  if (value !== parsedText) {
    parsedEvents = value
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Event)
    Object.freeze(parsedEvents)
    parsedText = value
  }
  // Shared and frozen: rules read one array (and one index); appending to it is a programming error.
  return parsedEvents
}

export type EventLogCheck = Readonly<{ valid: boolean; eventCount: number; error?: string }>

/** Check that every line is one JSON object; authenticity and history binding are checked elsewhere. */
export function checkEventLog(path: string, contents?: string): EventLogCheck {
  if (contents === undefined && !existsSync(path)) return { valid: true, eventCount: 0 }
  const lines = (contents ?? readFileSync(path, 'utf8')).split(/\r?\n/).filter(Boolean)
  for (const line of lines) {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      return { valid: false, eventCount: lines.length, error: 'EVENT_JSON_INVALID' }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return { valid: false, eventCount: lines.length, error: 'EVENT_RECORD_INVALID' }
  }
  return { valid: true, eventCount: lines.length }
}
