import { markdownProseLines } from './markdown-prose'
export type MarkdownSection = Readonly<{
  heading: string
  level: number
  startLine: number
  endLine: number
  text: string
}>

/** Locate real ATX headings while keeping original section bytes and excluding fenced examples. */
export function markdownSections(text: string): readonly MarkdownSection[] {
  const headings: { heading: string; level: number; offset: number; end: number; line: number }[] =
    []
  for (const { text: value, offset, line } of markdownProseLines(text)) {
    const match = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*$/.exec(value)
    if (match)
      headings.push({
        heading: match[2]!.replace(/[ \t]+#+[ \t]*$/, '').trim(),
        level: match[1]!.length,
        offset,
        end: offset + value.length,
        line
      })
  }
  return headings.map((heading, index) => {
    const next = headings[index + 1]
    return {
      heading: heading.heading,
      level: heading.level,
      startLine: heading.line,
      endLine: next ? next.line - 1 : text.split('\n').length,
      text: text.slice(heading.end, next?.offset ?? text.length)
    }
  })
}
