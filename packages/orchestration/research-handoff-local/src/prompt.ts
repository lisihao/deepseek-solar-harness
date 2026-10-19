/** Original research assets and exact single-pass prompt rendering; no external capability is inferred. */
import { readFileSync } from 'node:fs'
import {
  ResearchActionError, type ResearchPreparedPrompt, type ResearchPromptId, type ResearchPromptTemplate,
  type ResearchRetainedPromptPart,
} from '@deepseek-ai/dsh-research-handoff/api'
import { researchArtifactHash, researchArtifactText } from './artifact.ts'

const assets = {
  'prompts_01_gemini_deep_research.zh.txt': '83e6f50b9bb15caf1386e4f0d6e81cd219b4657e011e382da71d577ae6c76e68',
  'prompts_02_chatgpt_verify_synthesize.zh.txt': '8be75a3d1f9530b7f950753684a2629c5d46a2562ef44936e28e72748ecc8100',
  'prompts_03_handoff_contract.zh.md': 'bc8d1b92220076928dfbf9e320719b8f859f8461635b7958abf54ef673a35f9c',
  'prompts_04_research_basis.zh.md': 'a5dccc820c70dcda5a123411ecfb3fabf17526300ddb8e45eeacab93237eb3b1',
} as const
const templates = {
  'gemini-deep-research': 'prompts_01_gemini_deep_research.zh.txt',
  'chatgpt-verify-synthesize': 'prompts_02_chatgpt_verify_synthesize.zh.txt',
} as const

/**
 * Read one bundled original reference without normalization; historical source text is not a live account observation.
 * @param name - Explicit bundled original asset.
 * @returns Original text and byte digest; changed or missing assets fail.
 */
export function readResearchReferenceAsset(name: keyof typeof assets): { readonly text: string; readonly sha256: string } {
  const bytes = readFileSync(new URL('../prompts/' + name, import.meta.url))
  if (researchArtifactHash(bytes) !== assets[name]) throw new ResearchActionError('original research asset changed', 'FORMAT')
  return { text: researchArtifactText(bytes), sha256: assets[name] }
}

/**
 * Read the original versioned template; availability, selected model and effort require separate Host/Driver observations.
 * @param id - Explicit first- or second-stage prompt.
 * @returns Exact original template and version.
 */
export function readResearchPromptTemplate(id: ResearchPromptId): ResearchPromptTemplate {
  const sourceName = templates[id]
  const asset = readResearchReferenceAsset(sourceName)
  return { id, version: '1.0', sourceName, ...asset }
}

function exactText(value: unknown): string {
  if (typeof value !== 'string' || researchArtifactText(new TextEncoder().encode(value)) !== value) {
    throw new ResearchActionError('research prompt text is not lossless UTF-8', 'FORMAT')
  }
  return value
}

/**
 * Replace only slots in the original template; inserted values are never scanned again or silently truncated.
 * @param template - Exact selected original template.
 * @param values - Explicit complete slot values, retaining each artifact's original bytes.
 * @returns Full rendered text, including all prefixes and suffixes.
 */
export function renderResearchPrompt(template: ResearchPromptTemplate,
  values: Readonly<Record<string, readonly ResearchRetainedPromptPart[]>>): string {
  const slots = new Set([...template.text.matchAll(/<([a-z_]+)>/g)].map(match => match[0].slice(1, -1)))
  if (Object.keys(values).length !== slots.size || Object.keys(values).some(key => !slots.has(key))) {
    throw new ResearchActionError('research prompt slots missing or unexpected', 'FORMAT')
  }
  const rendered = template.text.replace(/<([a-z_]+)>/g, (_match, name: string) => {
    const parts = values[name]
    if (parts === undefined || parts.length === 0) throw new ResearchActionError('research prompt slot is missing', 'FORMAT')
    return parts.map(part => exactText(part.text)).join('')
  })
  return exactText(rendered)
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ResearchActionError('invalid prepared research input', 'FORMAT')
  }
  return value as Record<string, unknown>
}

/**
 * Validate imported or durable prepared input without restoring Host authority or substituting requested observations.
 * @param value - Untrusted retained JSON.
 * @returns Canonical complete input and original provenance; corruption fails.
 */
export function parseResearchPreparedPrompt(value: unknown): ResearchPreparedPrompt {
  const record = object(value)
  const templateRecord = object(record.template)
  if (templateRecord.id !== 'gemini-deep-research' && templateRecord.id !== 'chatgpt-verify-synthesize') {
    throw new ResearchActionError('unknown research prompt template', 'FORMAT')
  }
  const template = readResearchPromptTemplate(templateRecord.id)
  if (templateRecord.version !== template.version || templateRecord.sourceName !== template.sourceName
    || templateRecord.sha256 !== template.sha256 || templateRecord.text !== template.text) {
    throw new ResearchActionError('prepared research template changed', 'FORMAT')
  }
  const inputValues = object(record.values)
  const values: Record<string, ResearchRetainedPromptPart[]> = {}
  for (const name of Object.keys(inputValues).sort()) {
    const parts = inputValues[name]
    if (!Array.isArray(parts) || parts.length === 0) throw new ResearchActionError('invalid research prompt value', 'FORMAT')
    values[name] = parts.map((value) => {
      const part = object(value)
      const text = exactText(part.text)
      if (part.kind === 'text') return { kind: 'text', text }
      if (part.kind !== 'artifact' || typeof part.artifactId !== 'string' || !part.artifactId
        || !Number.isSafeInteger(part.version) || (part.version as number) < 1
        || part.sha256 !== researchArtifactHash(new TextEncoder().encode(text))) {
        throw new ResearchActionError('invalid research prompt artifact provenance', 'FORMAT')
      }
      return { kind: 'artifact', artifactId: part.artifactId as Extract<ResearchRetainedPromptPart, { kind: 'artifact' }>['artifactId'],
        version: part.version as number, sha256: part.sha256, text }
    })
  }
  const question = values.user_question
  if (question?.length !== 1 || question[0]?.kind !== 'text' || !question[0].text.trim()
    || record.questionSha256 !== researchArtifactHash(new TextEncoder().encode(question[0].text))) {
    throw new ResearchActionError('research prompt needs the original Host question', 'FORMAT')
  }
  const renderedText = renderResearchPrompt(template, values)
  const preparedAt = exactText(record.preparedAt)
  if (!Number.isFinite(Date.parse(preparedAt)) || new Date(preparedAt).toISOString() !== preparedAt
    || record.renderedText !== renderedText || record.renderedSha256 !== researchArtifactHash(new TextEncoder().encode(renderedText))
    || typeof record.runId !== 'string' || !record.runId || typeof record.inputId !== 'string' || !record.inputId
    || !Number.isSafeInteger(record.revision) || (record.revision as number) < 1) {
    throw new ResearchActionError('invalid prepared research identity or exact text', 'FORMAT')
  }
  return { inputId: record.inputId as ResearchPreparedPrompt['inputId'], runId: record.runId as ResearchPreparedPrompt['runId'],
    revision: record.revision as number, questionSha256: record.questionSha256, template, values,
    renderedText, renderedSha256: record.renderedSha256, preparedAt }
}
