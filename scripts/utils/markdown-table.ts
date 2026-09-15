/** Split a GFM table row on unescaped pipes, preserving escaped content and empty cells. */
export function tableCells(line: string): string[] {
  const cells: string[] = []
  let start = 0,
    slashes = 0
  for (let index = 0; index < line.length; index++) {
    const character = line[index]
    if (character === '|' && slashes % 2 === 0) {
      cells.push(line.slice(start, index).trim())
      start = index + 1
    }
    slashes = character === '\\' ? slashes + 1 : 0
  }
  cells.push(line.slice(start).trim())
  if (line.trimStart().startsWith('|')) cells.shift()
  if (/(?<!\\)(?:\\\\)*\|\s*$/.test(line)) cells.pop()
  return cells
}
