import { readContractDocument } from '../services/contract-document'
import { checkDocument, checkDocumentText } from '../domain/document-check'
import { readFileSync } from 'node:fs'
import { markdownSections } from '../utils/markdown-sections'
import { readContractText } from '../domain/contract'
import type { DocumentPolicy } from '../domain/document-presentation'
import { assertDeliveryPlan } from '../domain/delivery-plan'
import { assertAuthoringClosure } from '../domain/policies/authoring-closure'
import { assertContractReferences } from '../helpers/contract-references'
import { assertExperienceContract } from '../domain/experience-contract'
import { assertArchitecture, assertDeliveryPlatforms } from '../domain/platform-architecture'
export type DocumentCheckResult = Readonly<{
  sdd: string
  valid: boolean
  diagnostics: ReturnType<typeof checkDocument>
}>
const REQUIRED = [
  'Breaking Changes',
  'New/Changed API & Typing',
  'New/Changed Entities & Tools',
  'Implementation Flow & Pseudocode',
  'Delivery & Verification'
] as const

/** Check the versioned contract and presentation using the execution parser; standalone prose uses table diagnostics. */
export function documentCheck(sdd: string): DocumentCheckResult {
  const diagnostics: ReturnType<typeof checkDocument>[number][] = []
  try {
    // Contract documents use their versioned policy, including authoritative JSON
    // definitions and linked normative tables. Do not apply a second prose ID graph.
    if (!readContractDocument(sdd)) diagnostics.push(...checkDocument(sdd))
  } catch (error) {
    diagnostics.push({
      code: 'SDD_CONTRACT_INVALID',
      line: 1,
      message: error instanceof Error ? error.message : 'Contract parsing failed'
    })
  }
  return { sdd, valid: diagnostics.length === 0, diagnostics }
}

/** One in-memory implementation backs both persisted and draft validation. */
function validateText(
  text: string,
  sdd: string,
  documents: readonly { path: string; content: string }[] = [],
  policy: DocumentPolicy = 'legacy'
) {
  const diagnostics: ReturnType<typeof checkDocument>[number][] = []
  let deliveryPlan: ReturnType<typeof assertDeliveryPlan> = null
  let experienceContract: ReturnType<typeof assertExperienceContract> = null
  let deliveryPlatforms: ReturnType<typeof assertDeliveryPlatforms> = null
  let architecture: ReturnType<typeof assertArchitecture> = null
  // Section and table checks cannot prove that the embedded machine contract is
  // parseable. Use the same parser as init/amend before reporting structural validity.
  try {
    if (documents.length && sdd === '<stdin>') throw Error('DRAFT_ROOT_PATH_REQUIRED')
    const contract =
      sdd === '<stdin>'
        ? readContractText(text, { self: text }, policy)
        : readContractDocument(sdd, text, documents, policy)
    if (!contract) {
      diagnostics.push(...checkDocumentText(text))
      // validate is the implementation gate; prose-only documents use document-check instead.
      diagnostics.push({
        code: 'SDD_CONTRACT_REQUIRED',
        line: 1,
        message: 'implementation SDD has no sdd-contract block; draft it before validating'
      })
    }
    // Waves and critical path let the author see the parallelism the plan actually allows.
    else {
      assertAuthoringClosure(contract)
      if (sdd !== '<stdin>')
        assertContractReferences(
          contract,
          sdd,
          documents.map((document) => document.path)
        )
      deliveryPlan = assertDeliveryPlan(contract)
      deliveryPlatforms = assertDeliveryPlatforms(contract)
      experienceContract = assertExperienceContract(contract)
      architecture = assertArchitecture(contract)
    }
  } catch (error) {
    diagnostics.push({
      code: 'SDD_CONTRACT_INVALID',
      line: 1,
      message: error instanceof Error ? error.message : 'Contract parsing failed'
    })
  }
  {
    const sections = markdownSections(text)
    for (const heading of REQUIRED) {
      // Section numbering such as "4.1 " or "6. " is presentation, not a different section.
      const index = sections.findIndex(
        (section) => section.heading.replace(/^\d+(?:\.\d+)*\.?\s+/, '') === heading
      )
      if (index < 0) {
        diagnostics.push({
          code: 'SDD_REQUIRED_SECTION_MISSING',
          line: 1,
          message: 'missing required section: ' + heading
        })
        continue
      }
      const current = sections[index]!
      const next = sections.slice(index + 1).find((section) => section.level <= current.level)
      const body = text
        .split(/\r?\n/)
        .slice(current.startLine, next ? next.startLine - 1 : undefined)
        .join('\n')
        .trim()
      if (!body)
        diagnostics.push({
          code: 'SDD_REQUIRED_SECTION_EMPTY',
          line: current.startLine,
          message: 'required section has no body: ' + heading
        })
      if (
        heading === 'Implementation Flow & Pseudocode' &&
        /^\s*(?:(?:[-*]|\d+\.)\s+)?(?:(?:#|\/\/|\/\*|<!--)\s*)?(?:TODO|TBD|FIXME|待补充|待实现)(?:\s|[:：—-]|$)/im.test(
          body
        )
      )
        diagnostics.push({
          code: 'SDD_IMPLEMENTATION_PLACEHOLDER',
          line: current.startLine,
          message: 'implementation flow contains an explicit placeholder'
        })
    }
  }
  return {
    sdd,
    valid: diagnostics.length === 0,
    diagnostics,
    requiredSections: REQUIRED,
    ...(deliveryPlan ? { deliveryPlan } : {}),
    ...(experienceContract ? { experienceContract } : {}),
    ...(deliveryPlatforms ? { deliveryPlatforms } : {}),
    ...(architecture ? { architecture } : {})
  }
}
export function validateDocument(sdd: string, policy: DocumentPolicy = 'legacy') {
  return validateText(readFileSync(sdd, 'utf8'), sdd, [], policy)
}
/** File-backed draft validation shares the exact memory parser and never creates state. */
export function validateDraft(sdd: string, policy: DocumentPolicy = 'legacy') {
  return validateDraftText(readFileSync(sdd, 'utf8'), sdd, [], policy)
}
/** Validate candidate bytes without creating an SDD or sidecar. */
export function validateDraftText(
  text: string,
  source = '<stdin>',
  documents: readonly { path: string; content: string }[] = [],
  policy: DocumentPolicy = 'legacy'
) {
  return {
    ...validateText(text, source, documents, policy),
    draft: true as const,
    persisted: false as const
  }
}

/** Suggest the next stable identifier without modifying the document. */
export function nextDocumentId(
  sdd: string,
  prefix: string
): Readonly<{ prefix: string; next: string }> {
  if (!/^[A-Z]{2}$/.test(prefix)) throw new Error('DOCUMENT_PREFIX_INVALID')
  const text = readFileSync(sdd, 'utf8')
  const values = [...text.matchAll(new RegExp(`\\b${prefix}([0-9]{2,4})\\b`, 'g'))].map((m) =>
    Number(m[1])
  )
  const next = (values.length ? Math.max(...values) + 1 : 1).toString().padStart(2, '0')
  if (next.length > 4) throw new Error('DOCUMENT_ID_EXHAUSTED')
  return { prefix, next: `${prefix}${next}` }
}
