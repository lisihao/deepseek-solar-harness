/**
 * A complete skill snapshot entry used by the bounded discovery search.
 *
 * The search deliberately accepts only the fields that can be exposed to a
 * model.  Skill bodies stay with the official loader and are never read here.
 */
export interface SkillSearchEntry {
  readonly name: string
  readonly description: string
}

/** Limits applied to one search response. */
export interface SkillSearchOptions {
  readonly maxResults: number
  readonly maxDescriptionChars: number
  readonly maxResponseBytes: number
}

export interface SkillSearchMatch {
  readonly name: string
  readonly description: string
}

export interface SkillSearchResult {
  readonly matches: readonly SkillSearchMatch[]
  readonly totalMatches: number
  readonly nextOffset?: number
}

/** Defaults used by the parent plugin when exposing discovery to the model. */
export const DEFAULT_SKILL_SEARCH_OPTIONS: SkillSearchOptions = {
  maxResults: 8,
  maxDescriptionChars: 240,
  maxResponseBytes: 8_192,
}

/** A stable error type for malformed requests and an unrepresentable page. */
export class SkillSearchError extends Error {
  constructor(
    readonly code: 'invalid_entries' | 'invalid_query' | 'invalid_offset' | 'invalid_options' | 'response_limit',
    message: string,
  ) {
    super(message)
    this.name = 'SkillSearchError'
  }
}

// These upper bounds keep the tool bounded even when its arguments arrive
// from an untrusted model/tool boundary.  They are deliberately above the
// normal catalog size and response defaults.
const MAX_RESULTS = 10_000
const MAX_DESCRIPTION_CHARS = 100_000
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

const OPTION_KEYS = new Set(['maxResults', 'maxDescriptionChars', 'maxResponseBytes'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireBoundedInteger(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new SkillSearchError('invalid_options', `solar_skill_search ${field} must be an integer from ${min} to ${max}`)
  }
  return value as number
}

function validateEntries(entries: unknown): readonly SkillSearchEntry[] {
  if (!Array.isArray(entries)) {
    throw new SkillSearchError('invalid_entries', 'solar_skill_search entries must be an array')
  }

  for (const [index, entry] of entries.entries()) {
    if (!isRecord(entry)) {
      throw new SkillSearchError('invalid_entries', `solar_skill_search entries[${index}] must be an object`)
    }
    if (typeof entry.name !== 'string' || entry.name.trim().length === 0) {
      throw new SkillSearchError(`invalid_entries`, `solar_skill_search entries[${index}].name must be a non-empty string`)
    }
    if (typeof entry.description !== 'string') {
      throw new SkillSearchError('invalid_entries', `solar_skill_search entries[${index}].description must be a string`)
    }
  }

  return entries as readonly SkillSearchEntry[]
}

function validateQuery(query: unknown): string {
  if (typeof query !== 'string') {
    throw new SkillSearchError('invalid_query', 'solar_skill_search query must be a string')
  }
  const trimmed = query.trim()
  const length = Array.from(trimmed).length
  if (length < 1 || length > 256) {
    throw new SkillSearchError('invalid_query', 'solar_skill_search query must contain 1 to 256 characters after trimming')
  }
  return trimmed
}

function validateOffset(offset: unknown): number {
  if (!Number.isSafeInteger(offset) || (offset as number) < 0) {
    throw new SkillSearchError('invalid_offset', 'solar_skill_search offset must be a non-negative integer')
  }
  return offset as number
}

function validateOptions(options: unknown): SkillSearchOptions {
  if (!isRecord(options)) {
    throw new SkillSearchError('invalid_options', 'solar_skill_search options must be an object')
  }
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) {
      throw new SkillSearchError('invalid_options', `solar_skill_search options contains unsupported field "${key}"`)
    }
  }
  return {
    maxResults: requireBoundedInteger(options.maxResults, 'maxResults', 1, MAX_RESULTS),
    maxDescriptionChars: requireBoundedInteger(options.maxDescriptionChars, 'maxDescriptionChars', 0, MAX_DESCRIPTION_CHARS),
    maxResponseBytes: requireBoundedInteger(options.maxResponseBytes, 'maxResponseBytes', 1, MAX_RESPONSE_BYTES),
  }
}

function utf8Bytes(value: SkillSearchResult): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function buildResult(matches: readonly SkillSearchMatch[], totalMatches: number, nextOffset: number | undefined): SkillSearchResult {
  return nextOffset === undefined
    ? { matches, totalMatches }
    : { matches, totalMatches, nextOffset }
}

function compareNames(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function matchRank(entry: SkillSearchEntry, normalizedQuery: string): number {
  const name = entry.name.toLowerCase()
  if (name === normalizedQuery) return 0
  if (name.startsWith(normalizedQuery)) return 1
  if (name.includes(normalizedQuery)) return 2
  const terms = normalizedQuery.split(/\s+/u)
  if (terms.every(term => name.includes(term))) return 2
  const searchable = `${name}\n${entry.description.toLowerCase()}`
  if (terms.every(term => searchable.includes(term))) return 3
  return -1
}

function truncateCharacters(value: string, maxCharacters: number): string {
  if (maxCharacters === 0) return ''
  const characters = Array.from(value)
  return characters.length <= maxCharacters ? value : characters.slice(0, maxCharacters).join('')
}

/**
 * Return the longest description that still permits a complete JSON page to
 * fit within the response byte limit.  Names are never truncated.
 */
function fitDescription(
  baseMatches: readonly SkillSearchMatch[],
  entry: SkillSearchEntry,
  totalMatches: number,
  nextOffset: number | undefined,
  options: SkillSearchOptions,
): string | undefined {
  const description = truncateCharacters(entry.description, options.maxDescriptionChars)
  const characters = Array.from(description)
  const fits = (length: number): boolean => {
    const candidate: SkillSearchMatch = {
      name: entry.name,
      description: characters.slice(0, length).join(''),
    }
    return utf8Bytes(buildResult([...baseMatches, candidate], totalMatches, nextOffset)) <= options.maxResponseBytes
  }

  if (fits(characters.length)) return description
  if (!fits(0)) return undefined

  let low = 0
  let high = characters.length
  let best = 0
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (fits(middle)) {
      best = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return characters.slice(0, best).join('')
}

/**
 * Search a complete skill snapshot without consulting a model or network.
 *
 * Results are ranked as exact name, name prefix, name term, and description
 * term.  Ties use the original name's code-point order, then source order for
 * duplicate names.  `offset` is an offset into that stable sorted match list.
 */
export function searchSkills(
  entries: readonly SkillSearchEntry[],
  query: string,
  offset: number,
  options: SkillSearchOptions = DEFAULT_SKILL_SEARCH_OPTIONS,
): SkillSearchResult {
  const validatedEntries = validateEntries(entries)
  const trimmedQuery = validateQuery(query)
  const validatedOffset = validateOffset(offset)
  const validatedOptions = validateOptions(options)
  const normalizedQuery = trimmedQuery.toLowerCase()

  const ranked = validatedEntries
    .map((entry, sourceIndex) => ({ entry, sourceIndex, rank: matchRank(entry, normalizedQuery) }))
    .filter((candidate) => candidate.rank >= 0)
    .sort((left, right) => left.rank - right.rank || compareNames(left.entry.name, right.entry.name) || left.sourceIndex - right.sourceIndex)

  const totalMatches = ranked.length
  if (validatedOffset >= totalMatches) {
    const empty = buildResult([], totalMatches, undefined)
    if (utf8Bytes(empty) > validatedOptions.maxResponseBytes) {
      throw new SkillSearchError('response_limit', 'solar_skill_search response byte limit cannot fit an empty result')
    }
    return empty
  }

  const matches: SkillSearchMatch[] = []
  let nextOffset: number | undefined
  const pageEnd = Math.min(totalMatches, validatedOffset + validatedOptions.maxResults)

  for (let matchIndex = validatedOffset; matchIndex < pageEnd; matchIndex += 1) {
    const candidate = ranked[matchIndex]
    // `matchIndex < totalMatches` is guaranteed by the loop condition, but
    // retain the guard for strict noUncheckedIndexedAccess builds.
    if (candidate === undefined) break
    const candidateNextOffset = matchIndex + 1 < totalMatches ? matchIndex + 1 : undefined
    const description = fitDescription(matches, candidate.entry, totalMatches, candidateNextOffset, validatedOptions)
    if (description === undefined) {
      if (matches.length === 0) {
        throw new SkillSearchError(
          'response_limit',
          'solar_skill_search response byte limit cannot fit a matching skill name; refine the query or change the configured limit',
        )
      }
      nextOffset = matchIndex
      break
    }

    matches.push({ name: candidate.entry.name, description })
    nextOffset = candidateNextOffset
  }

  const result = buildResult(matches, totalMatches, nextOffset)
  if (utf8Bytes(result) > validatedOptions.maxResponseBytes) {
    // This should be unreachable because each candidate was checked against
    // the same complete envelope, but keep the boundary explicit if the
    // representation changes in the future.
    throw new SkillSearchError('response_limit', 'solar_skill_search response exceeds maxResponseBytes')
  }
  return result
}
