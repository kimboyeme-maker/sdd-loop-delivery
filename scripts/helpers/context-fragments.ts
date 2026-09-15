import { createHash } from 'node:crypto'
import { markdownSections } from '../utils/markdown-sections'

/** Partition original text without overlaps or omissions. Duplicate heading identities
 * disable partial reuse rather than guessing which occurrence the agent read.
 */
export function contextFragments(
  text: string
): { fragment: string; sha256: string; bytes: number; text: string }[] {
  const headings = markdownSections(text)
  const names = headings.map((section) => '#'.repeat(section.level) + ' ' + section.heading)
  const make = (fragment: string, value: string) => ({
    fragment,
    text: value,
    sha256: createHash('sha256').update(value).digest('hex'),
    bytes: Buffer.byteLength(value)
  })
  if (!headings.length || new Set(names).size !== names.length) return [make('@document', text)]
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const output = []
  if (headings[0]!.startLine > 1)
    output.push(make('@preamble', lines.slice(0, headings[0]!.startLine - 1).join('')))
  for (const [index, section] of headings.entries())
    output.push(
      make(
        names[index]!,
        lines
          .slice(
            section.startLine - 1,
            headings[index + 1] ? headings[index + 1]!.startLine - 1 : lines.length
          )
          .join('')
      )
    )
  return output
}
