import { APP_PLATFORMS, UI_PLATFORMS } from './platform-architecture'

type Item = Record<string, unknown>
const object = (value: unknown): Item | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : undefined
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
const ids = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(text) &&
  new Set(value).size === value.length

/** Product archetypes by primary user value; the first six have a user interface. */
export const PRODUCT_ARCHETYPES = [
  'content-publication',
  'marketing-site',
  'commerce',
  'web-application',
  'data-dashboard',
  'internal-operations',
  'developer-tool',
  'library-or-service'
] as const
const UI_ARCHETYPES = new Set(PRODUCT_ARCHETYPES.slice(0, 6))
/** Route kinds; content publications must cover their reading, browsing and discovery kinds. */
const ROUTE_KINDS = new Set([
  'home',
  'article',
  'index',
  'taxonomy',
  'series',
  'search',
  'feed',
  'sitemap',
  'page',
  'error',
  'app',
  'checkout',
  'dashboard',
  'settings',
  // Native and mini-program navigation units; `deep-link` marks every external entry.
  'screen',
  'tab',
  'sheet',
  'deep-link',
  'widget',
  'notification',
  'other'
])
/** Design token categories a style hook may declare. */
const TOKEN_CATEGORIES = new Set([
  'color',
  'typography',
  'space',
  'size',
  'radius',
  'shadow',
  'motion',
  'layout',
  'z-index',
  'breakpoint'
])

export type ExperienceSummary = Readonly<{
  protocol: 'experience-contract/v1'
  product_archetype: string
  scope: 'product' | 'delta'
  routes: number
  templates: number
  journeys: number
  tokens: number
}>

/**
 * Validate the optional `product_archetype` and `experience_contract` projection. A UI product
 * must decide its route set, templates, journeys and style hooks before implementation; a
 * content publication additionally fixes readability targets and the reading/discovery routes
 * and proves a reader can continue from an article. Structure only: taste is not validated.
 */
export function assertExperienceContract(contract: Item): ExperienceSummary | null {
  const archetype = contract.product_archetype
  if (archetype === undefined && contract.experience_contract === undefined) return null
  if (!PRODUCT_ARCHETYPES.includes(archetype as (typeof PRODUCT_ARCHETYPES)[number]))
    throw new Error('PRODUCT_ARCHETYPE_INVALID')
  const platforms = Array.isArray(contract.delivery_platforms)
    ? (contract.delivery_platforms as string[])
    : []
  const uiPlatform = platforms.find((platform) => UI_PLATFORMS.has(platform))
  const ui = UI_ARCHETYPES.has(archetype as (typeof PRODUCT_ARCHETYPES)[number]) || !!uiPlatform
  // App platforms navigate by page path or screen ID; web-only products keep URL paths.
  const appNavigation = platforms.some((platform) => APP_PLATFORMS.has(platform))
  if (contract.experience_contract === undefined) {
    if (ui) throw new Error(`EXPERIENCE_CONTRACT_REQUIRED: ${String(uiPlatform ?? archetype)}`)
    return null
  }
  const experience = object(contract.experience_contract)
  if (!experience || experience.protocol !== 'experience-contract/v1')
    throw new Error('EXPERIENCE_CONTRACT_INVALID')
  const requirementIds = new Set(
    (Array.isArray(contract.requirements) ? contract.requirements : []).map((r) => object(r)?.id)
  )
  const acceptanceIds = new Set(
    (Array.isArray(contract.acceptance) ? contract.acceptance : []).map((a) => object(a)?.id)
  )
  const knownAcceptance = (value: unknown) =>
    ids(value) && value.every((id) => acceptanceIds.has(id))

  const templates = new Map<string, Item>()
  for (const value of Array.isArray(experience.templates) ? experience.templates : []) {
    const template = object(value)
    if (!template || !text(template.id) || !text(template.purpose) || !ids(template.regions))
      throw new Error('EXPERIENCE_TEMPLATE_INVALID')
    if (templates.has(template.id)) throw new Error('EXPERIENCE_TEMPLATE_DUPLICATE')
    templates.set(template.id, template)
  }
  if (!templates.size) throw new Error('EXPERIENCE_TEMPLATES_REQUIRED')

  const routes = new Map<string, Item>()
  const paths = new Set<string>()
  const usedTemplates = new Set<string>()
  for (const value of Array.isArray(experience.routes) ? experience.routes : []) {
    const route = object(value)
    if (
      !route ||
      !text(route.id) ||
      !text(route.path) ||
      !(
        route.path.startsWith('/') ||
        (appNavigation && /^[A-Za-z0-9_][\w\-./:[\]]*$/.test(route.path))
      ) ||
      !ROUTE_KINDS.has(String(route.kind)) ||
      !text(route.purpose) ||
      !ids(route.requirement_ids) ||
      !knownAcceptance(route.acceptance_ids)
    )
      throw new Error('EXPERIENCE_ROUTE_INVALID')
    if (routes.has(route.id) || paths.has(route.path))
      throw new Error(`EXPERIENCE_ROUTE_DUPLICATE: ${route.id}`)
    if (!templates.has(String(route.template)))
      throw new Error(`EXPERIENCE_ROUTE_TEMPLATE_UNKNOWN: ${route.id}`)
    if ((route.requirement_ids as string[]).some((id) => !requirementIds.has(id)))
      throw new Error(`EXPERIENCE_ROUTE_REQUIREMENT_UNKNOWN: ${route.id}`)
    routes.set(route.id, route)
    paths.add(route.path)
    usedTemplates.add(String(route.template))
  }
  if (!routes.size) throw new Error('EXPERIENCE_ROUTES_REQUIRED')
  for (const id of templates.keys())
    if (!usedTemplates.has(id)) throw new Error(`EXPERIENCE_TEMPLATE_UNUSED: ${id}`)

  const journeys = Array.isArray(experience.journeys) ? experience.journeys.map(object) : []
  if (!journeys.length) throw new Error('EXPERIENCE_JOURNEYS_REQUIRED')
  const journeyIds = new Set<string>()
  for (const journey of journeys) {
    const steps = Array.isArray(journey?.steps) ? journey.steps.map(object) : []
    if (
      !journey ||
      !text(journey.id) ||
      journeyIds.has(journey.id) ||
      !text(journey.audience) ||
      steps.length < 2 ||
      steps.some((step) => !step || !routes.has(String(step.route_id)) || !text(step.intent)) ||
      !knownAcceptance(journey.acceptance_ids)
    )
      throw new Error('EXPERIENCE_JOURNEY_INVALID')
    journeyIds.add(journey.id)
  }

  const hooks = object(experience.style_hooks)
  const tokens = new Set<string>()
  for (const value of Array.isArray(hooks?.tokens) ? hooks.tokens : []) {
    const token = object(value)
    if (
      !token ||
      !text(token.name) ||
      !/^--[a-z0-9][a-z0-9-]*$/.test(token.name) ||
      !TOKEN_CATEGORIES.has(String(token.category)) ||
      !text(token.purpose)
    )
      throw new Error('EXPERIENCE_STYLE_TOKEN_INVALID')
    if (tokens.has(token.name)) throw new Error(`EXPERIENCE_STYLE_TOKEN_DUPLICATE: ${token.name}`)
    tokens.add(token.name)
  }
  const components = Array.isArray(hooks?.component_hooks) ? hooks.component_hooks.map(object) : []
  if (!tokens.size || !components.length) throw new Error('EXPERIENCE_STYLE_HOOKS_REQUIRED')
  for (const component of components) {
    if (!component || !text(component.component) || !ids(component.hooks) || !ids(component.tokens))
      throw new Error('EXPERIENCE_COMPONENT_HOOK_INVALID')
    const unknown = (component.tokens as string[]).find((name) => !tokens.has(name))
    if (unknown) throw new Error(`EXPERIENCE_STYLE_HOOK_TOKEN_UNKNOWN: ${unknown}`)
  }

  // A delta contract covers only the routes a change touches on an existing product. The full
  // route set, readability and reading continuation stay with the document that owns the product.
  const scope = experience.scope ?? 'product'
  if (scope !== 'product' && scope !== 'delta') throw new Error('EXPERIENCE_SCOPE_INVALID')
  // A typed reference ({kind, paths|url}) is resolved against the repository at validate time.
  if (
    scope === 'delta' &&
    !text(experience.product_contract) &&
    !object(experience.product_contract)
  )
    throw new Error('EXPERIENCE_DELTA_PRODUCT_CONTRACT_REQUIRED')
  if (archetype === 'content-publication' && scope === 'product') {
    const readability = object(experience.readability)
    const measure = readability?.measure_ch
    if (
      !readability ||
      !Array.isArray(measure) ||
      measure.length !== 2 ||
      !Number.isInteger(measure[0]) ||
      !Number.isInteger(measure[1]) ||
      Number(measure[0]) < 45 ||
      Number(measure[0]) >= Number(measure[1]) ||
      Number(measure[1]) > 90 ||
      typeof readability.body_font_px !== 'number' ||
      readability.body_font_px < 15 ||
      readability.body_font_px > 24 ||
      typeof readability.line_height !== 'number' ||
      readability.line_height < 1.4 ||
      readability.line_height > 2 ||
      !['AA', 'AAA'].includes(String(readability.contrast)) ||
      !knownAcceptance(readability.acceptance_ids)
    )
      throw new Error('EXPERIENCE_READABILITY_REQUIRED')
    const kinds = new Set([...routes.values()].map((route) => String(route.kind)))
    const missing = ['home', 'article', 'feed', 'sitemap', 'error'].filter(
      (kind) => !kinds.has(kind)
    )
    if (!kinds.has('index') && !kinds.has('taxonomy')) missing.push('index|taxonomy')
    if (missing.length) throw new Error(`EXPERIENCE_CONTENT_ROUTES_MISSING: ${missing.join(',')}`)
    // A reader who finishes an article must be offered a next step on another reading route.
    const continues = journeys.some((journey) => {
      const steps = (journey!.steps as Item[]).map((step) => routes.get(String(step.route_id))!)
      return steps.some(
        (step, index) =>
          step.kind === 'article' &&
          index < steps.length - 1 &&
          ['article', 'series', 'taxonomy', 'index'].includes(String(steps[index + 1]!.kind))
      )
    })
    if (!continues) throw new Error('EXPERIENCE_READING_CONTINUATION_REQUIRED')
  }
  return {
    protocol: 'experience-contract/v1',
    scope,
    product_archetype: String(archetype),
    routes: routes.size,
    templates: templates.size,
    journeys: journeys.length,
    tokens: tokens.size
  }
}
