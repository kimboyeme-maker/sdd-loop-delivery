import { isAbsolute, normalize, relative, sep } from 'node:path'

export type PreActionResult = Readonly<{
  protocol: 'pre-action/v1'
  workspace: string
  requested: string
  normalized: string
  allowed: boolean
  risk: 'none' | 'path-traversal' | 'outside-workspace'
}>

/** Check path shape before a mutation; this does not grant a lease or write files. */
export function preAction(workspace: string, requested: string): PreActionResult {
  const normalized = normalize(requested)
  const workspacePath = normalize(workspace)
  const outside = isAbsolute(requested) || normalized === '..' || normalized.startsWith(`..${sep}`)
  const relativePath = relative(workspacePath, normalize(`${workspacePath}/${requested}`))
  const escaped = relativePath === '..' || relativePath.startsWith(`..${sep}`)
  const risk =
    outside || escaped ? (isAbsolute(requested) ? 'outside-workspace' : 'path-traversal') : 'none'
  return {
    protocol: 'pre-action/v1',
    workspace,
    requested,
    normalized,
    allowed: risk === 'none',
    risk
  }
}
