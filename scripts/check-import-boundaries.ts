import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = join(import.meta.dir)
const violations: string[] = []
const forbidden: Record<string, readonly string[]> = {
  '/utils/': ['/domain/', '/controllers/', '/services/', '/resource/'],
  '/domain/': ['/resource/', '/controllers/', '/services/'],
  '/helpers/': ['/services/', '/controllers/']
}
function walk(path: string): string[] {
  return readdirSync(path).flatMap((name) => {
    const child = join(path, name)
    return lstatSync(child).isDirectory() ? walk(child) : child.endsWith('.ts') ? [child] : []
  })
}
for (const file of walk(root)) {
  const source = readFileSync(file, 'utf8')
  const normalized = `/${relative(root, file)}`
  const layer = Object.keys(forbidden).find((key) => normalized.includes(key))
  if (!layer) continue
  for (const target of forbidden[layer]!) {
    const staticImport = new RegExp(`from\\s+["'][^"']*${target.slice(1)}`)
    const dynamicImport = new RegExp(`import\\(\\s*["'][^"']*${target.slice(1)}`)
    if (staticImport.test(source) || dynamicImport.test(source))
      violations.push(`${relative(root, file)} imports ${target}`)
  }
}
if (violations.length) {
  console.error(violations.join('\n'))
  process.exit(1)
}
console.log('PASS: import boundaries')
