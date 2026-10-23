import { describe, expect, it } from 'vitest'

import { CatalogError, catalogRevision, searchTools, toolRevision, type CatalogEntry } from '../src/catalog.js'

function tool(name: string, description: string, parameters: Record<string, unknown> = { type: 'object', properties: {} }, output: Record<string, unknown> = { type: 'string' }): CatalogEntry {
  return { name, description, parameters, output }
}

const limits = { maxResults: 2, maxDescriptionChars: 200, maxSearchBytes: 4096 }

describe('caller-scoped tool catalog search', () => {
  it('ranks exact names, paginates deterministically, and reports the registry revision', () => {
    const entries = [
      tool('workspace_lookup', 'Reads a workspace value.'),
      tool('workspace_delete', 'Deletes a workspace value.'),
      tool('workspace_list', 'Lists workspace values.'),
    ]
    const first = searchTools(entries, 'workspace_lookup', 0, limits)
    const second = searchTools(entries, 'workspace_lookup', 1, limits)

    expect(first.formatVersion).toBe(1)
    expect(first.totalMatches).toBe(1)
    expect(first.results.map((result) => result.name)).toEqual(['workspace_lookup'])
    expect(first.nextOffset).toBeUndefined()
    expect(second.results).toEqual([])
    expect(second.registryRevision).toBe(first.registryRevision)

    const broad = searchTools(entries, 'workspace', 0, limits)
    expect(broad.results.map((result) => result.name)).toEqual(['workspace_list', 'workspace_lookup'])
    expect(broad.nextOffset).toBe(2)
    expect(searchTools(entries, 'workspace', 2, limits).results.map((result) => result.name)).toEqual(['workspace_delete'])
  })

  it('matches Unicode keywords case-insensitively and keeps caller input unchanged', () => {
    const entries = [
      tool('Gödel-检查', '分析 workspace 数据'),
      tool('other', 'unrelated'),
    ]
    const before = structuredClone(entries)
    const result = searchTools(entries, 'GÖDEL 检查', 0, limits)
    expect(result.results.map((entry) => entry.name)).toEqual(['Gödel-检查'])
    expect(entries).toEqual(before)
  })

  it('hashes schema objects independent of key order while preserving array order', () => {
    const first = tool('hash', 'hash', {
      type: 'object',
      properties: { b: { type: 'string' }, a: { type: 'number' } },
      required: ['a', 'b'],
    }, { oneOf: [{ type: 'string' }, { type: 'number' }] })
    const reordered = tool('hash', 'hash', {
      required: ['a', 'b'],
      properties: { a: { type: 'number' }, b: { type: 'string' } },
      type: 'object',
    }, { oneOf: [{ type: 'string' }, { type: 'number' }] })
    const arrayChanged = tool('hash', 'hash', first.parameters, { oneOf: [{ type: 'number' }, { type: 'string' }] })

    expect(toolRevision(first)).toBe(toolRevision(reordered))
    expect(catalogRevision([first])).toBe(catalogRevision([reordered]))
    expect(toolRevision(first)).not.toBe(toolRevision(arrayChanged))
    expect(searchTools([first], 'hash', 0, limits).results[0]?.schemaHash).toBe(toolRevision(first))
    expect(toolRevision({ ...first, description: 'changed' })).not.toBe(toolRevision(first))
    expect(toolRevision({ ...first, deferLoading: true })).not.toBe(toolRevision(first))
    const other = tool('other-hash', 'other')
    expect(catalogRevision([first, other])).not.toBe(catalogRevision([other, first]))
  })

  it('changes registry identity when a scoped entry changes and never discovers outside entries', () => {
    const local = [tool('local_tool', 'Only this entry is visible.')]
    const changed = [tool('local_tool', 'Only this entry is visible.'), tool('outside_tool', 'Should not be found.')]
    expect(catalogRevision(local)).not.toBe(catalogRevision(changed))
    expect(searchTools(local, 'outside', 0, limits).results).toEqual([])
  })

  it('shrinks descriptions to stay under the UTF-8 byte cap without consuming a match', () => {
    const entries = [tool('工具', '这是一个非常长的描述，用于测试 UTF-8 字节预算。')]
    const result = searchTools(entries, '工具', 0, { maxResults: 1, maxDescriptionChars: 200, maxSearchBytes: 280 })
    expect(result.results).toHaveLength(1)
    expect(result.results[0]?.name).toBe('工具')
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(280)
    expect(result.results[0]?.schemaHash).toHaveLength(64)

    expect(() => searchTools(entries, '工具', 0, { maxResults: 1, maxDescriptionChars: 200, maxSearchBytes: 100 })).toThrow(CatalogError)
    expect(() => searchTools(entries, '工具', 0, { maxResults: 1, maxDescriptionChars: 200, maxSearchBytes: 100 })).toThrow('cannot fit')
  })

  it('validates Unicode query and safe pagination offset', () => {
    expect(() => searchTools([], '', 0, limits)).toThrow('between 1 and 256 Unicode characters')
    expect(() => searchTools([], 'a'.repeat(257), 0, limits)).toThrow('between 1 and 256 Unicode characters')
    expect(() => searchTools([], 'a', -1, limits)).toThrow('non-negative safe integer')
    expect(() => searchTools([], 'a', Number.MAX_SAFE_INTEGER + 1, limits)).toThrow('non-negative safe integer')
  })
})
