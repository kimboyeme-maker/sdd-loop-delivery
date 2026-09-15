import { existsSync, readFileSync } from 'node:fs'
import policy from '../../agents/roles.json'
import claudeCode from '../../agents/hosts/claude-code.json'
import codex from '../../agents/hosts/codex.json'
import generic from '../../agents/hosts/generic.json'

/** Selects a bundled host profile by id; the default keeps existing Codex deliveries unchanged. */
export const HOST_ENV = 'SDD_LOOP_HOST'
/** Absolute path of a custom `host-profile/v1` JSON file (PI, custom harnesses); wins over HOST_ENV. */
export const HOST_PROFILE_FILE_ENV = 'SDD_LOOP_HOST_PROFILE_FILE'
export const DEFAULT_HOST = 'codex'

/** Host-neutral capability tiers; roles name a tier, each host profile maps it to real models. */
export const RUNTIME_TIERS = ['frontier', 'standard', 'efficient', 'review'] as const
export type RuntimeTier = (typeof RUNTIME_TIERS)[number]

/** Neutral operation vocabulary every role document uses instead of host tool names. */
export const HOST_OPERATIONS = [
  'spawn',
  'direction_update',
  'idle_continuation',
  'wait',
  'interrupt_turn',
  'close',
  'observe',
  'resume_closed',
  'goal_create',
  'goal_read',
  'goal_complete',
  'goal_get',
  'goal_set',
  'goal_clear',
  'turn_steer',
  'turn_interrupt',
  'usage_read',
  'user_goal_control',
  // Cross-SDD workflow: independent top-level tasks, each in its own worktree.
  'task_create',
  'task_message',
  'task_wait',
  'task_list',
  'wake_schedule',
  'project_discover'
] as const
export type HostOperation = (typeof HOST_OPERATIONS)[number]

type Tier = {
  spawn_model: string | null
  accepted_models: string[]
  reasoning_effort: string | null
}
type Operation = {
  available: boolean
  kind?: string
  call?: string
  params?: string[]
  reason?: string
  [key: string]: unknown
}
export type HostProfile = {
  protocol: 'host-profile/v1'
  id: string
  display_name: string
  sources: string[]
  skill_roots: string[]
  tiers: Record<RuntimeTier, Tier>
  context: Record<
    'isolated' | 'inherited',
    { spawn_args: Record<string, unknown>; receipt_values: string[] }
  >
  concurrency: { config_key: string | null }
  operations: Record<HostOperation, Operation>
}

const BUNDLED: Readonly<Record<string, unknown>> = { codex, 'claude-code': claudeCode, generic }

/** Reject a profile that would let a role silently fall back to an undeclared host behavior. */
export function assertHostProfile(value: unknown): HostProfile {
  const profile = value as HostProfile
  const strings = (items: unknown) =>
    Array.isArray(items) && items.every((item) => typeof item === 'string' && item.length > 0)
  if (
    !profile ||
    profile.protocol !== 'host-profile/v1' ||
    typeof profile.id !== 'string' ||
    !profile.id ||
    !strings(profile.skill_roots) ||
    RUNTIME_TIERS.some((tier) => {
      const entry = profile.tiers?.[tier]
      return (
        !entry ||
        !strings(entry.accepted_models) ||
        (entry.spawn_model !== null && !entry.accepted_models.includes(entry.spawn_model))
      )
    }) ||
    (['isolated', 'inherited'] as const).some(
      (kind) => !strings(profile.context?.[kind]?.receipt_values)
    ) ||
    HOST_OPERATIONS.some((name) => {
      const operation = profile.operations?.[name]
      return (
        !operation ||
        typeof operation.available !== 'boolean' ||
        (operation.available
          ? typeof operation.call !== 'string' || !strings(operation.params ?? ['-'])
          : typeof operation.reason !== 'string')
      )
    })
  )
    throw new Error('HOST_PROFILE_INVALID')
  return profile
}

/** Resolve the active host: explicit profile file, then bundled id, then the default. */
export function hostProfile(
  env: Readonly<Record<string, string | undefined>> = process.env
): HostProfile {
  const file = env[HOST_PROFILE_FILE_ENV]
  if (file) {
    if (!existsSync(file)) throw new Error('HOST_PROFILE_FILE_NOT_FOUND')
    return assertHostProfile(JSON.parse(readFileSync(file, 'utf8')))
  }
  const id = env[HOST_ENV] ?? DEFAULT_HOST
  if (!Object.hasOwn(BUNDLED, id)) throw new Error('HOST_PROFILE_UNKNOWN')
  return assertHostProfile(BUNDLED[id])
}

export type RoleRuntime = Readonly<{
  tier: RuntimeTier | null
  spawn_model: string | null
  accepted_models: readonly string[]
  reasoning_effort: string | null
  context: 'isolated' | 'inherited'
  isolation_values: readonly string[]
  spawn_args: Readonly<Record<string, unknown>>
}>

function resolve(tier: string | null, context: string, host: HostProfile): RoleRuntime {
  const kind = context === 'inherited' ? 'inherited' : 'isolated'
  const entry = tier === null ? null : host.tiers[tier as RuntimeTier]
  if (tier !== null && !entry) throw new Error('ROLE_RUNTIME_TIER_UNKNOWN')
  return {
    tier: tier as RuntimeTier | null,
    spawn_model: entry?.spawn_model ?? null,
    accepted_models: entry?.accepted_models ?? [],
    reasoning_effort: entry?.reasoning_effort ?? null,
    context: kind,
    isolation_values: host.context[kind].receipt_values,
    spawn_args: host.context[kind].spawn_args
  }
}

/** Runtime selection for a fixed role on the active host. */
export function roleRuntime(
  role: 'supervisor' | 'coordinator' | 'architect',
  host: HostProfile = hostProfile()
): RoleRuntime {
  const entry = policy.roles[role]
  return resolve(entry.runtime_tier, entry.context, host)
}

/** Runtime selection for one Operator profile on the active host. */
export function operatorRuntime(profile: string, host: HostProfile = hostProfile()): RoleRuntime {
  const profiles = policy.roles.operator.profiles as Record<string, { runtime_tier: string }>
  if (!Object.hasOwn(profiles, profile)) throw new Error('OPERATOR_PROFILE_INVALID')
  return resolve(profiles[profile]!.runtime_tier, policy.roles.operator.context, host)
}

/**
 * Observed model/effort match the expected tier. A host that cannot pin models (empty
 * accepted_models) accepts any reported model; an unpinned effort accepts any value.
 */
export function runtimeMatches(
  expected: RoleRuntime,
  observed: { model?: unknown; reasoning_effort?: unknown }
): boolean {
  if (typeof observed.model !== 'string' || !observed.model) return false
  if (expected.accepted_models.length && !expected.accepted_models.includes(observed.model))
    return false
  return (
    expected.reasoning_effort === null ||
    observed.reasoning_effort === undefined ||
    observed.reasoning_effort === expected.reasoning_effort
  )
}

/** Public projection: which neutral operations the active host provides, and how to call them. */
export function hostCapabilities(host: HostProfile = hostProfile()): object {
  const operations = host.operations
  const goalPauseResume = operations.goal_get.available && operations.goal_set.available
  return {
    protocol: 'host-capabilities/v1',
    host: host.id,
    display_name: host.display_name,
    selection: { env: HOST_ENV, profile_file_env: HOST_PROFILE_FILE_ENV, default: DEFAULT_HOST },
    availability: 'host-tool-probe-required',
    // Profile availability is protocol support; this session's tools may differ. Confirm the tool and
    // record it (runtime-record observe, e.g. close_available) before relying on an operation.
    operation_meaning: 'protocol-support-not-session-proof',
    operations,
    goal_control: {
      pause_resume: goalPauseResume,
      clear: operations.goal_clear.available,
      in_flight_steer: operations.turn_steer.available,
      immediate_suspend: goalPauseResume && operations.turn_interrupt.available,
      model_goal_tools: operations.goal_create.available,
      pid_is_transport: false
    },
    context: host.context,
    concurrency: host.concurrency
  }
}
