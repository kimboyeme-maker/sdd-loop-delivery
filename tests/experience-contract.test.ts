import { expect, test } from 'bun:test'
import { assertExperienceContract } from '../scripts/domain/experience-contract'

type Item = Record<string, unknown>

/** A small blog: routes, templates, journeys, style hooks and readability decided up front. */
function blog(patch: (experience: Item) => void = () => {}): Item {
  const route = (id: string, path: string, kind: string, template: string) => ({
    id,
    path,
    kind,
    template,
    purpose: `${kind} route`,
    requirement_ids: ['XQ01'],
    acceptance_ids: ['YS01']
  })
  const experience: Item = {
    protocol: 'experience-contract/v1',
    templates: [
      {
        id: 'TP01',
        purpose: 'read and continue',
        regions: ['orientation', 'body', 'continuation']
      },
      { id: 'TP02', purpose: 'browse', regions: ['listing', 'pagination'] },
      { id: 'TP03', purpose: 'machine and error surfaces', regions: ['body'] }
    ],
    routes: [
      route('RT01', '/', 'home', 'TP02'),
      route('RT02', '/posts/[slug]', 'article', 'TP01'),
      route('RT03', '/tags/[tag]', 'taxonomy', 'TP02'),
      route('RT04', '/feed.xml', 'feed', 'TP03'),
      route('RT05', '/sitemap.xml', 'sitemap', 'TP03'),
      route('RT06', '/404', 'error', 'TP03')
    ],
    journeys: [
      {
        id: 'JN01',
        audience: 'search visitor',
        steps: [
          { route_id: 'RT02', intent: 'read the answer' },
          { route_id: 'RT03', intent: 'continue within the topic' }
        ],
        acceptance_ids: ['YS01']
      }
    ],
    style_hooks: {
      tokens: [
        { name: '--measure-reading', category: 'layout', purpose: 'article column width' },
        { name: '--font-size-body', category: 'typography', purpose: 'body size' }
      ],
      component_hooks: [
        {
          component: 'ArticleBody',
          hooks: ['.prose'],
          tokens: ['--measure-reading', '--font-size-body']
        }
      ]
    },
    readability: {
      measure_ch: [60, 75],
      body_font_px: 18,
      line_height: 1.7,
      contrast: 'AA',
      acceptance_ids: ['YS01']
    }
  }
  patch(experience)
  return {
    product_archetype: 'content-publication',
    requirements: [{ id: 'XQ01', kind: 'must-ship', title: 'blog', acceptance: ['YS01'] }],
    acceptance: [{ id: 'YS01' }],
    experience_contract: experience
  }
}

test('a content publication must decide routes, journeys, style hooks and readability', () => {
  expect(assertExperienceContract(blog())).toEqual({
    protocol: 'experience-contract/v1',
    product_archetype: 'content-publication',
    scope: 'product',
    routes: 6,
    templates: 3,
    journeys: 1,
    tokens: 2
  })
  // No archetype and no experience block: legacy documents stay valid.
  expect(assertExperienceContract({ requirements: [] })).toBeNull()
  // A library needs no experience contract; a UI product always does.
  expect(assertExperienceContract({ product_archetype: 'library-or-service' })).toBeNull()
  expect(() => assertExperienceContract({ product_archetype: 'content-publication' })).toThrow(
    'EXPERIENCE_CONTRACT_REQUIRED'
  )
  const cases: [(experience: Item) => void, string][] = [
    [
      (e) => ((e.routes as Item[])[3] = { ...(e.routes as Item[])[3], kind: 'page' }),
      'EXPERIENCE_CONTENT_ROUTES_MISSING: feed'
    ],
    [(e) => delete e.readability, 'EXPERIENCE_READABILITY_REQUIRED'],
    [(e) => ((e.readability as Item).measure_ch = [40, 120]), 'EXPERIENCE_READABILITY_REQUIRED'],
    [
      (e) =>
        (((e.journeys as Item[])[0]!.steps as Item[])[1] = {
          route_id: 'RT04',
          intent: 'subscribe'
        }),
      'EXPERIENCE_READING_CONTINUATION_REQUIRED'
    ],
    [
      (e) =>
        (((e.style_hooks as Item).component_hooks as Item[])[0]!.tokens = ['--color-undeclared']),
      'EXPERIENCE_STYLE_HOOK_TOKEN_UNKNOWN'
    ],
    [(e) => ((e.routes as Item[])[1]!.template = 'TP99'), 'EXPERIENCE_ROUTE_TEMPLATE_UNKNOWN'],
    [
      (e) => (e.templates as Item[]).push({ id: 'TP09', purpose: 'orphan', regions: ['body'] }),
      'EXPERIENCE_TEMPLATE_UNUSED'
    ],
    [(e) => ((e.routes as Item[])[2]!.path = '/'), 'EXPERIENCE_ROUTE_DUPLICATE'],
    [(e) => ((e.routes as Item[])[0]!.acceptance_ids = ['YS99']), 'EXPERIENCE_ROUTE_INVALID']
  ]
  for (const [patch, error] of cases)
    expect(() => assertExperienceContract(blog(patch))).toThrow(error)
})

test('a delta contract on an existing content site names its owner instead of repeating the full route set', () => {
  const headerOnly = (patch: Item) => ({
    product_archetype: 'content-publication',
    requirements: [{ id: 'XQ01', kind: 'must-ship', title: 'search panel', acceptance: ['YS01'] }],
    acceptance: [{ id: 'YS01' }],
    experience_contract: {
      protocol: 'experience-contract/v1',
      templates: [
        { id: 'TP01', purpose: 'site shell header', regions: ['header', 'search dialog'] }
      ],
      routes: [
        {
          id: 'RT01',
          path: '/en',
          kind: 'home',
          template: 'TP01',
          purpose: 'open search',
          requirement_ids: ['XQ01'],
          acceptance_ids: ['YS01']
        },
        {
          id: 'RT02',
          path: '/en/docs/utils',
          kind: 'article',
          template: 'TP01',
          purpose: 'land on a result',
          requirement_ids: ['XQ01'],
          acceptance_ids: ['YS01']
        }
      ],
      journeys: [
        {
          id: 'JN01',
          audience: 'reader',
          steps: [
            { route_id: 'RT01', intent: 'search' },
            { route_id: 'RT02', intent: 'read the result' }
          ],
          acceptance_ids: ['YS01']
        }
      ],
      style_hooks: {
        tokens: [{ name: '--accent-default', category: 'color', purpose: 'result link' }],
        component_hooks: [
          { component: 'SearchPanel', hooks: ['.search-panel'], tokens: ['--accent-default'] }
        ]
      },
      ...patch
    }
  })
  expect(() => assertExperienceContract(headerOnly({}))).toThrow('EXPERIENCE_READABILITY_REQUIRED')
  expect(() => assertExperienceContract(headerOnly({ scope: 'delta' }))).toThrow(
    'EXPERIENCE_DELTA_PRODUCT_CONTRACT_REQUIRED'
  )
  expect(
    assertExperienceContract(
      headerOnly({
        scope: 'delta',
        product_contract: 'docs/website/library-documentation-site.sdd.md'
      })
    )
  ).toMatchObject({ scope: 'delta', routes: 2 })
  expect(() =>
    assertExperienceContract(headerOnly({ scope: 'partial', product_contract: 'x' }))
  ).toThrow('EXPERIENCE_SCOPE_INVALID')
})
