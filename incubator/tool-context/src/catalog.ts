import { createHash } from 'node:crypto'

import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'

/** The caller-scoped description of one model-visible tool. */
export interface CatalogEntry {
  readonly name: string
  readonly description: string
  readonly parameters: ToolSchema['parameters']
  readonly output: JsonSchemaNode
  readonly deferLoading?: ToolSchema['deferLoading']
}

/** Bounds supplied by the host when it exposes a catalog search tool. */
export interface CatalogLimits {
  readonly maxResults: number
  readonly maxDescriptionChars: number
  readonly maxSearchBytes: number
}

export interface CatalogSearchResult {
  readonly formatVersion: 1
  readonly registryRevision: string
  readonly totalMatches: number
  results: Array<{
    readonly name: string
    readonly description: string
    readonly schemaHash: string
  }>
  readonly nextOffset?: number
}

export type CatalogErrorCode = 'INVALID_QUERY' | 'INVALID_OFFSET' | 'INVALID_LIMITS' | 'RESULT_TOO_LARGE' | 'INVALID_CATALOG'

/** Stable errors raised before a result is returned to the model. */
export class CatalogError extends Error {
  constructor(readonly code: CatalogErrorCode, message: string) {
    super(message)
    this.name = 'CatalogError'
  }
}

/**
 * Return the revision of one tool declaration.
 *
 * The input is projected into a plain JSON record before hashing. Object keys
 * are canonicalized recursively, while array order remains significant.
 */
export function toolRevision(entry: CatalogEntry): string {
  return sha256(canonicalJson(toolDescriptor(entry)))
}

/**
 * Return a revision for the complete caller-scoped registry.
 *
 * The registry array is canonicalized without mutating the caller's array.
 * Arrays intentionally preserve order; a registry reordering is therefore a
 * visible revision even when its declarations are otherwise unchanged.
 */
export function catalogRevision(entries: readonly CatalogEntry[]): string {
  return sha256(canonicalJson(entries.map((entry) => toolDescriptor(entry))))
}

/**
 * Search only the supplied caller-scoped entries and return a bounded page.
 * No global registry or fallback discovery is consulted.
 */
export function searchTools(
  entries: readonly CatalogEntry[],
  query: string,
  offset: number,
  limits: CatalogLimits,
): CatalogSearchResult {
  validateQuery(query)
  validateOffset(offset)
  validateLimits(limits)

  const registryRevision = catalogRevision(entries)
  const foldedQuery = fold(query)
  const keywords = foldedQuery.split(/\s+/u).filter((keyword) => keyword.length > 0)
  const matches = entries
    .map((entry, index) => matchEntry(entry, query, foldedQuery, keywords, index))
    .filter((match): match is SearchMatch => match !== undefined)
    .sort(compareMatches)

  const totalMatches = matches.length
  const available = offset < totalMatches ? Math.min(limits.maxResults, totalMatches - offset) : 0
  const emptyResponse = makeResponse(registryRevision, totalMatches, [])

  if (available === 0) {
    ensureFits(emptyResponse, limits.maxSearchBytes, 'Catalog search response metadata cannot fit within maxSearchBytes.')
    return emptyResponse
  }

  // Select the largest page whose names and hashes can fit. Descriptions may
  // be shortened later, but a name or schema hash is never split or omitted.
  let pageSize = 0
  for (let candidateSize = available; candidateSize > 0; candidateSize -= 1) {
    const candidateResults = matches.slice(offset, offset + candidateSize).map((match) => ({
      name: match.entry.name,
      description: '',
      schemaHash: match.schemaHash,
    }))
    const candidate = makeResponse(registryRevision, totalMatches, candidateResults, offset + candidateSize < totalMatches ? offset + candidateSize : undefined)
    if (jsonBytes(candidate) <= limits.maxSearchBytes) {
      pageSize = candidateSize
      break
    }
  }

  if (pageSize === 0) {
    const name = matches[offset]?.entry.name ?? 'the first matched tool'
    throw new CatalogError('RESULT_TOO_LARGE', `Catalog search result for ${JSON.stringify(name)} cannot fit within maxSearchBytes even with an empty description.`)
  }

  const pageMatches = matches.slice(offset, offset + pageSize)
  const descriptions = pageMatches.map((match) => takeCharacters(match.entry.description, limits.maxDescriptionChars))
  const hasMore = offset + pageSize < totalMatches
  const nextOffset = hasMore ? offset + pageSize : undefined

  // Preserve as much of each description as the remaining byte budget allows,
  // in result order. Future descriptions start empty so earlier entries cannot
  // make a later entry disappear from the page.
  for (let index = 0; index < descriptions.length; index += 1) {
    const fullDescription = descriptions[index] ?? ''
    let low = 0
    let high = characterCount(fullDescription)
    let best = 0
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const candidateDescriptions = descriptions.map((description, candidateIndex) => candidateIndex < index ? description : candidateIndex === index ? takeCharacters(fullDescription, middle) : '')
      const candidateResults = pageMatches.map((match, candidateIndex) => ({
        name: match.entry.name,
        description: candidateDescriptions[candidateIndex] ?? '',
        schemaHash: match.schemaHash,
      }))
      const candidate = makeResponse(registryRevision, totalMatches, candidateResults, nextOffset)
      if (jsonBytes(candidate) <= limits.maxSearchBytes) {
        best = middle
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    descriptions[index] = takeCharacters(fullDescription, best)
  }

  const results = pageMatches.map((match, index) => ({
    name: match.entry.name,
    description: descriptions[index] ?? '',
    schemaHash: match.schemaHash,
  }))
  const response = makeResponse(registryRevision, totalMatches, results, nextOffset)
  ensureFits(response, limits.maxSearchBytes, 'Catalog search response cannot fit within maxSearchBytes.')
  return response
}

interface SearchMatch {
  readonly entry: CatalogEntry
  readonly schemaHash: string
  readonly index: number
  readonly exactName: boolean
  readonly foldedExactName: boolean
  readonly keywordCount: number
  readonly nameKeywordMatches: number
  readonly descriptionKeywordMatches: number
  readonly firstNamePosition: number
  readonly firstDescriptionPosition: number
}

function matchEntry(entry: CatalogEntry, query: string, foldedQuery: string, keywords: readonly string[], index: number): SearchMatch | undefined {
  assertCatalogEntry(entry)
  const foldedName = fold(entry.name)
  const foldedDescription = fold(entry.description)
  const nameKeywordMatches = keywords.filter((keyword) => foldedName.includes(keyword)).length
  const descriptionKeywordMatches = keywords.filter((keyword) => foldedDescription.includes(keyword)).length

  // Empty/whitespace-only queries have no keywords and therefore no matches.
  // Otherwise every keyword must occur in either the name or description.
  if (keywords.length > 0 && keywords.some((keyword) => !foldedName.includes(keyword) && !foldedDescription.includes(keyword))) return undefined
  if (keywords.length === 0) return undefined

  const firstNamePosition = firstKeywordPosition(foldedName, keywords)
  const firstDescriptionPosition = firstKeywordPosition(foldedDescription, keywords)
  return {
    entry,
    schemaHash: schemaHash(entry),
    index,
    exactName: entry.name === query,
    foldedExactName: foldedName === foldedQuery,
    keywordCount: keywords.length,
    nameKeywordMatches,
    descriptionKeywordMatches,
    firstNamePosition,
    firstDescriptionPosition,
  }
}

function compareMatches(left: SearchMatch, right: SearchMatch): number {
  if (left.exactName !== right.exactName) return left.exactName ? -1 : 1
  if (left.foldedExactName !== right.foldedExactName) return left.foldedExactName ? -1 : 1
  const leftAllInName = left.nameKeywordMatches === left.keywordCount
  const rightAllInName = right.nameKeywordMatches === right.keywordCount
  if (leftAllInName !== rightAllInName) return leftAllInName ? -1 : 1
  if (left.nameKeywordMatches !== right.nameKeywordMatches) return right.nameKeywordMatches - left.nameKeywordMatches
  if (left.descriptionKeywordMatches !== right.descriptionKeywordMatches) return right.descriptionKeywordMatches - left.descriptionKeywordMatches
  if (left.firstNamePosition !== right.firstNamePosition) return left.firstNamePosition - right.firstNamePosition
  if (left.firstDescriptionPosition !== right.firstDescriptionPosition) return left.firstDescriptionPosition - right.firstDescriptionPosition
  const nameOrder = left.entry.name < right.entry.name ? -1 : left.entry.name > right.entry.name ? 1 : 0
  if (nameOrder !== 0) return nameOrder
  const schemaOrder = left.schemaHash < right.schemaHash ? -1 : left.schemaHash > right.schemaHash ? 1 : 0
  return schemaOrder !== 0 ? schemaOrder : left.index - right.index
}

function schemaHash(entry: CatalogEntry): string {
  // The loader must invalidate a description/deferLoading change as well as a
  // parameter/output change, so the result uses the complete tool revision.
  return toolRevision(entry)
}

function toolDescriptor(entry: CatalogEntry): Record<string, unknown> {
  assertCatalogEntry(entry)
  return {
    name: entry.name,
    description: entry.description,
    parameters: entry.parameters,
    output: entry.output,
    ...(entry.deferLoading === undefined ? {} : { deferLoading: entry.deferLoading }),
  }
}

function assertCatalogEntry(entry: CatalogEntry): void {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new CatalogError('INVALID_CATALOG', 'Catalog entries must be objects.')
  if (typeof entry.name !== 'string' || entry.name.length === 0) throw new CatalogError('INVALID_CATALOG', 'Catalog tool names must be non-empty strings.')
  if (typeof entry.description !== 'string') throw new CatalogError('INVALID_CATALOG', `Catalog tool ${JSON.stringify(entry.name)} description must be a string.`)
  if (typeof entry.parameters !== 'object' || entry.parameters === null || Array.isArray(entry.parameters)) throw new CatalogError('INVALID_CATALOG', `Catalog tool ${JSON.stringify(entry.name)} parameters must be an object.`)
  if (typeof entry.output !== 'object' || entry.output === null || Array.isArray(entry.output)) throw new CatalogError('INVALID_CATALOG', `Catalog tool ${JSON.stringify(entry.name)} output must be a schema object.`)
  if (entry.deferLoading !== undefined && typeof entry.deferLoading !== 'boolean') throw new CatalogError('INVALID_CATALOG', `Catalog tool ${JSON.stringify(entry.name)} deferLoading must be a boolean when provided.`)
}

function validateQuery(query: string): void {
  if (typeof query !== 'string' || characterCount(query) < 1 || characterCount(query) > 256) {
    throw new CatalogError('INVALID_QUERY', 'Catalog search query must contain between 1 and 256 Unicode characters.')
  }
}

function validateOffset(offset: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new CatalogError('INVALID_OFFSET', 'Catalog search offset must be a non-negative safe integer.')
}

function validateLimits(limits: CatalogLimits): void {
  if (typeof limits !== 'object' || limits === null) throw new CatalogError('INVALID_LIMITS', 'Catalog search limits must be an object.')
  if (!Number.isSafeInteger(limits.maxResults) || limits.maxResults < 1) throw new CatalogError('INVALID_LIMITS', 'Catalog search maxResults must be a positive safe integer.')
  if (!Number.isSafeInteger(limits.maxDescriptionChars) || limits.maxDescriptionChars < 0) throw new CatalogError('INVALID_LIMITS', 'Catalog search maxDescriptionChars must be a non-negative safe integer.')
  if (!Number.isSafeInteger(limits.maxSearchBytes) || limits.maxSearchBytes < 1) throw new CatalogError('INVALID_LIMITS', 'Catalog search maxSearchBytes must be a positive safe integer.')
}

function makeResponse(registryRevision: string, totalMatches: number, results: readonly { readonly name: string; readonly description: string; readonly schemaHash: string }[], nextOffset?: number): CatalogSearchResult {
  return {
    formatVersion: 1,
    registryRevision,
    totalMatches,
    results: [...results],
    ...(nextOffset === undefined ? {} : { nextOffset }),
  }
}

function ensureFits(value: unknown, maxBytes: number, message: string): void {
  if (jsonBytes(value) > maxBytes) throw new CatalogError('RESULT_TOO_LARGE', message)
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function fold(value: string): string {
  return value.normalize('NFKC').toLowerCase()
}

function characterCount(value: string): number {
  return Array.from(value).length
}

function takeCharacters(value: string, count: number): string {
  if (count >= characterCount(value)) return value
  return Array.from(value).slice(0, count).join('')
}

function firstKeywordPosition(value: string, keywords: readonly string[]): number {
  let first = Number.POSITIVE_INFINITY
  for (const keyword of keywords) {
    const position = value.indexOf(keyword)
    if (position >= 0 && position < first) first = position
  }
  return Number.isFinite(first) ? first : Number.MAX_SAFE_INTEGER
}

/** Canonical JSON: object keys are sorted; arrays preserve their order. */
function canonicalJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CatalogError('INVALID_CATALOG', 'Catalog schemas cannot contain non-finite numbers.')
    return JSON.stringify(value)
  }
  if (typeof value !== 'object') throw new CatalogError('INVALID_CATALOG', 'Catalog schemas must contain only JSON values.')
  if (seen.has(value)) throw new CatalogError('INVALID_CATALOG', 'Catalog schemas cannot contain cyclic values.')
  seen.add(value)
  let result: string
  if (Array.isArray(value)) {
    result = `[${value.map((entry) => canonicalJson(entry, seen)).join(',')}]`
  } else {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    result = `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], seen)}`).join(',')}}`
  }
  seen.delete(value)
  return result
}
