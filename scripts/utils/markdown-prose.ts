/** Yield non-fenced source lines with original offsets; nested shorter fences remain examples. */
export function* markdownProseLines(
  text: string
): Generator<{ text: string; offset: number; line: number }> {
  let offset = 0
  let lineNumber = 1
  let fence: { character: string; length: number } | undefined
  for (const raw of text.split(/(?<=\n)/)) {
    const line = raw.replace(/\r?\n$/, '')
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (
        marker &&
        marker[1]![0] === fence.character &&
        marker[1]!.length >= fence.length &&
        !marker[2]!.trim()
      )
        fence = undefined
    } else if (marker) fence = { character: marker[1]![0]!, length: marker[1]!.length }
    else yield { text: line, offset, line: lineNumber }
    offset += raw.length
    if (raw.endsWith('\n')) lineNumber++
  }
}
