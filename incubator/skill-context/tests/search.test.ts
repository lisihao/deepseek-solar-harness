import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SKILL_SEARCH_OPTIONS,
  searchSkills,
  type SkillSearchEntry,
  type SkillSearchOptions,
} from '../src/search.js'

const options = (overrides: Partial<SkillSearchOptions> = {}): SkillSearchOptions => ({
  ...DEFAULT_SKILL_SEARCH_OPTIONS,
  ...overrides,
})

describe('bounded skill discovery search', () => {
  it('matches several keywords across the name and description without requiring a literal phrase', () => {
    const result = searchSkills([
      { name: 'pdf-tools', description: 'Read, edit and merge documents' },
      { name: 'image-edit', description: 'Edit images' },
    ], 'pdf edit', 0, options())
    expect(result.matches.map(entry => entry.name)).toEqual(['pdf-tools'])
  })
  it('finds an exact late entry in a 1,477-entry snapshot and keeps its full name', () => {
    const entries: SkillSearchEntry[] = Array.from({ length: 1_477 }, (_, index) => ({
      name: `skill/catalog-${String(index).padStart(4, '0')}`,
      description: `Catalog entry ${index}`,
    }))
    entries[1_476] = {
      name: 'skill/catalog-late-exact',
      description: 'The newest addition remains directly discoverable.',
    }

    const result = searchSkills(entries, 'skill/catalog-late-exact', 0, options())

    expect(result.totalMatches).toBe(1)
    expect(result.matches).toEqual([{
      name: 'skill/catalog-late-exact',
      description: 'The newest addition remains directly discoverable.',
    }])
    expect(result.nextOffset).toBeUndefined()
  })

  it('returns newly added entries while retaining the existing catalog entries', () => {
    const entries: SkillSearchEntry[] = [
      { name: 'skill/research', description: 'Research workflow' },
      { name: 'skill/research/updated', description: 'Updated research workflow' },
      { name: 'skill/new-catalog-entry', description: 'Newly added discovery entry' },
    ]

    const result = searchSkills(entries, 'research', 0, options())

    expect(result.totalMatches).toBe(2)
    expect(result.matches.map(({ name }) => name)).toEqual([
      'skill/research',
      'skill/research/updated',
    ])
    expect(searchSkills(entries, 'new-catalog-entry', 0, options()).matches[0]?.name).toBe('skill/new-catalog-entry')
  })

  it('paginates a broad match without dropping entries', () => {
    const entries: SkillSearchEntry[] = Array.from({ length: 1_477 }, (_, index) => ({
      name: `skill/catalog-${String(index).padStart(4, '0')}`,
      description: `Broad catalog match ${index}`,
    }))
    const found: string[] = []
    let offset = 0
    let pageCount = 0

    while (true) {
      const result = searchSkills(entries, 'skill', offset, options({ maxResults: 8 }))
      pageCount += 1
      found.push(...result.matches.map(({ name }) => name))
      if (result.nextOffset === undefined) break
      offset = result.nextOffset
    }

    expect(pageCount).toBeGreaterThan(1)
    expect(found).toHaveLength(1_477)
    expect(new Set(found).size).toBe(1_477)
    expect(found).toEqual(entries.map(({ name }) => name))
  })

  it('orders exact, prefix, name-term, and description-term matches deterministically', () => {
    const entries: SkillSearchEntry[] = [
      { name: 'zeta-needle-name-term', description: '' },
      { name: 'needle', description: '' },
      { name: 'needle-prefix', description: '' },
      { name: 'alpha-needle-name-term', description: '' },
      { name: 'description-only', description: 'needle appears in the description' },
    ]

    const result = searchSkills(entries, 'needle', 0, options())

    expect(result.matches.map(({ name }) => name)).toEqual([
      'needle',
      'needle-prefix',
      'alpha-needle-name-term',
      'zeta-needle-name-term',
      'description-only',
    ])
  })

  it('handles Unicode descriptions and enforces the complete UTF-8 JSON byte cap', () => {
    const result = searchSkills([
      { name: '技能/猫', description: '🐈‍⬛ 黑猫技能说明，包含多字节字符。' },
      { name: '技能/狗', description: '🐕 狗狗技能说明。' },
    ], '技能', 0, options({ maxDescriptionChars: 20, maxResponseBytes: 190 }))

    const serialized = JSON.stringify(result)
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(190)
    expect(JSON.parse(serialized)).toEqual(result)
    for (const match of result.matches) {
      expect(Array.from(match.description).length).toBeLessThanOrEqual(20)
    }
    expect(result.matches.map(({ name }) => name)).toEqual(['技能/狗', '技能/猫'])
  })

  it('rejects malformed boundary input and reports an unrepresentable matching name', () => {
    expect(() => searchSkills(null as never, 'skill', 0, options())).toThrow(/entries must be an array/)
    expect(() => searchSkills([{ name: '', description: 'bad' }], 'skill', 0, options())).toThrow(/name must be a non-empty string/)
    expect(() => searchSkills([{ name: 'skill', description: 1 as never }], 'skill', 0, options())).toThrow(/description must be a string/)
    expect(() => searchSkills([], '   ', 0, options())).toThrow(/query must contain 1 to 256 characters/)
    expect(() => searchSkills([], 'x'.repeat(257), 0, options())).toThrow(/query must contain 1 to 256 characters/)
    expect(() => searchSkills([], 'skill', 1.5, options())).toThrow(/offset must be a non-negative integer/)
    expect(() => searchSkills([], 'skill', 0, { ...options(), maxResults: 0 })).toThrow(/maxResults must be an integer/)
    expect(() => searchSkills([], 'skill', 0, { ...options(), maxDescriptionChars: -1 })).toThrow(/maxDescriptionChars must be an integer/)
    expect(() => searchSkills([], 'skill', 0, { ...options(), maxResponseBytes: Number.POSITIVE_INFINITY })).toThrow(/maxResponseBytes must be an integer/)
    expect(() => searchSkills([{ name: 'a-very-long-skill-name', description: '' }], 'skill', 0, options({ maxResponseBytes: 16 }))).toThrow(/cannot fit a matching skill name/)
    try {
      searchSkills([{ name: 'skill-' + 'x'.repeat(20_000), description: '' }], 'skill', 0, options())
      expect.fail('an oversized name must stop instead of becoming an oversized error')
    } catch (error) {
      expect(error).toMatchObject({ code: 'response_limit' })
      expect(Buffer.byteLength((error as Error).message, 'utf8')).toBeLessThan(256)
    }
  })

  it('returns an explicit empty page for zero matches', () => {
    expect(searchSkills([
      { name: 'skill/research', description: 'Research workflow' },
    ], 'missing', 0, options())).toEqual({ matches: [], totalMatches: 0 })
  })
})
