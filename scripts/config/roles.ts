import policy from '../../agents/roles.json'
import { hostProfile, operatorRuntime, roleRuntime } from './host'
import { ROLES, type Role } from './constants'

/** Control-record writing is distinct from product edits; only Operator may write product files. */
export const ROLE_TABLE: Readonly<Record<Role, Readonly<{ owns: string; mayWrite: boolean }>>> = {
  Supervisor: { owns: 'public progress and user routing', mayWrite: false },
  Coordinator: { owns: 'admission, lease routing, recovery, and final route', mayWrite: true },
  Operator: { owns: 'admitted implementation and self-check', mayWrite: true },
  Architect: { owns: 'independent verification and Findings', mayWrite: true }
}

/** Public configuration derives model settings from the same policy used for dispatch. */
export function roleTable() {
  const host = hostProfile()
  return ROLES.map((role) => {
    const key = role.toLowerCase() as 'supervisor' | 'coordinator' | 'operator' | 'architect'
    const runtime =
      key === 'operator'
        ? operatorRuntime(policy.roles.operator.default_profile, host)
        : roleRuntime(key, host)
    return {
      role,
      ...ROLE_TABLE[role],
      mayWriteProduct: role === 'Operator',
      host: host.id,
      runtime_tier: runtime.tier,
      model: runtime.spawn_model,
      reasoning_effort: runtime.reasoning_effort,
      context: runtime.context,
      spawn_args: runtime.spawn_args,
      ...(role === 'Operator'
        ? {
            default_profile: policy.roles.operator.default_profile,
            profiles: Object.fromEntries(
              Object.entries(policy.roles.operator.profiles).map(([name, entry]) => {
                const selected = operatorRuntime(name, host)
                return [
                  name,
                  {
                    ...entry,
                    model: selected.spawn_model,
                    reasoning_effort: selected.reasoning_effort
                  }
                ]
              })
            )
          }
        : {})
    }
  })
}
