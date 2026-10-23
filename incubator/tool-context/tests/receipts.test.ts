import { renderToolsSdk, type PtcDispatchEventData } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'

import {
  DISCOVERY_NOTICE,
  LOAD_NAME,
  SEARCH_NAME,
  makeReceipt,
  parseReceipt,
  renderSelection,
  type LoadReceipt,
  type SelectedTool,
} from '../src/receipts.js'
import { toolRevision, type CatalogEntry } from '../src/catalog.js'

const SESSION_ID = 'session-receipts'
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

function tool(name: string, description: string, execute?: ReturnType<typeof vi.fn>): CatalogEntry {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The complete query.' },
        mode: { type: 'string', enum: ['exact', 'fuzzy'] },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      type: 'object',
      properties: { value: { type: 'string' }, score: { type: 'number' } },
      required: ['value'],
      additionalProperties: false,
    },
    ...(execute === undefined ? {} : { execute }),
  } as CatalogEntry
}

function catalog(execute = vi.fn()): { entries: CatalogEntry[]; search: CatalogEntry; load: CatalogEntry; alpha: CatalogEntry; beta: CatalogEntry; gamma: CatalogEntry; execute: ReturnType<typeof vi.fn> } {
  const search = tool(SEARCH_NAME, 'Search the caller-scoped tool catalog.', execute)
  const load = tool(LOAD_NAME, 'Load complete declarations by exact name.', execute)
  const alpha = tool('alpha_tool', 'First business tool.', execute)
  const beta = tool('beta_tool', 'Second business tool.', execute)
  const gamma = tool('gamma_tool', 'Third business tool.', execute)
  return { entries: [search, load, alpha, beta, gamma], search, load, alpha, beta, gamma, execute }
}

function selected(entry: CatalogEntry): SelectedTool {
  return { name: entry.name, schemaHash: toolRevision(entry) }
}

function receipt(overrides: Partial<LoadReceipt> = {}): LoadReceipt {
  return {
    formatVersion: 1,
    kind: 'solar-tool-context-load',
    sessionId: SESSION_ID,
    registryRevision: 'c'.repeat(64),
    requested: ['alpha_tool'],
    selected: [{ name: 'alpha_tool', schemaHash: HASH_A }],
    evictedNames: [],
    selectedSdkBytes: 123,
    ...overrides,
  }
}

function dispatch(overrides: Partial<PtcDispatchEventData> = {}): PtcDispatchEventData {
  const value = receipt()
  return {
    rootCallId: 'root-call' as PtcDispatchEventData['rootCallId'],
    parentCallId: 'parent-call' as PtcDispatchEventData['parentCallId'],
    subCallId: 'sub-call' as PtcDispatchEventData['subCallId'],
    name: LOAD_NAME,
    arguments: { names: value.requested },
    isError: false,
    content: [{ type: 'text', text: JSON.stringify(value) }],
    ...overrides,
  }
}

describe('tool-context receipts', () => {
  it('renders the complete selected schemas through the official SDK renderer', () => {
    const { entries, search, load, alpha, execute } = catalog()
    const selectedEntry = selected(alpha)
    const rendered = renderSelection(entries, [selectedEntry], 'function-body')
    const expected = `${DISCOVERY_NOTICE}\n\n${renderToolsSdk([search, load, alpha], 'function-body')}`

    expect(rendered).toBe(expected)
    expect(rendered).toContain('The complete query.')
    expect(rendered).toContain('score?: number')
    expect(execute).not.toHaveBeenCalled()
  })

  it('keeps the newest requested tool and evicts the oldest prior selection', () => {
    const { entries, alpha, beta, gamma, execute } = catalog()
    const previous = [selected(alpha), selected(beta)]
    const before = structuredClone(previous)
    const result = makeReceipt(SESSION_ID, entries, previous, [gamma.name], { maxLoadedTools: 2, maxLoadedBytes: 1_000_000 }, 'function-body')

    expect(result.selected.map(item => item.name)).toEqual([beta.name, gamma.name])
    expect(result.evictedNames).toEqual([alpha.name])
    expect(previous).toEqual(before)
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects an oversized single tool and group without changing previous selection', () => {
    const { entries: baseEntries, alpha, beta } = catalog()
    const oversized: CatalogEntry = { ...alpha, name: 'oversized_tool', description: 'oversized '.repeat(5_000) }
    const entries = [...baseEntries, oversized]
    const previous = [selected(alpha)]
    const before = structuredClone(previous)
    const maxLoadedBytes = Buffer.byteLength(renderSelection(entries, previous, 'function-body'))
    const limits = { maxLoadedTools: 4, maxLoadedBytes }

    expect(() => makeReceipt(SESSION_ID, entries, previous, [oversized.name], limits, 'function-body')).toThrow('TOOL_CONTEXT_SCHEMA_TOO_LARGE')
    expect(previous).toEqual(before)
    expect(() => makeReceipt(SESSION_ID, entries, previous, [oversized.name, beta.name], limits, 'function-body')).toThrow('TOOL_CONTEXT_SCHEMA_TOO_LARGE')
    expect(previous).toEqual(before)
  })

  it('rejects a byte budget below the discovery bootstrap without hanging', () => {
    const { entries, alpha, beta } = catalog()
    const previous = [selected(alpha)]
    const before = structuredClone(previous)

    expect(() => makeReceipt(SESSION_ID, entries, previous, [beta.name], { maxLoadedTools: 2, maxLoadedBytes: 1 }, 'function-body')).toThrow('TOOL_CONTEXT_SCHEMA_TOO_LARGE')
    expect(previous).toEqual(before)
  })

  it('requires distinct exact business-tool names', () => {
    const { entries, alpha } = catalog()
    const limits = { maxLoadedTools: 4, maxLoadedBytes: 1_000_000 }

    expect(() => makeReceipt(SESSION_ID, entries, [], ['alpha'], limits, 'function-body')).toThrow('TOOL_CONTEXT_TOOL_UNAVAILABLE')
    expect(() => makeReceipt(SESSION_ID, entries, [], ['ALPHA_TOOL'], limits, 'function-body')).toThrow('TOOL_CONTEXT_TOOL_UNAVAILABLE')
    expect(() => makeReceipt(SESSION_ID, entries, [], [alpha.name, alpha.name], limits, 'function-body')).toThrow('TOOL_CONTEXT_LOAD_INVALID')
    expect(() => makeReceipt(SESSION_ID, entries, [], [SEARCH_NAME], limits, 'function-body')).toThrow('TOOL_CONTEXT_LOAD_INVALID')
  })

  it('accepts one valid receipt and rejects malformed, foreign, or forged shapes', () => {
    const valid = dispatch()
    expect(parseReceipt(valid, SESSION_ID)).toEqual(receipt())

    const failures: PtcDispatchEventData[] = [
      dispatch({ name: SEARCH_NAME }),
      dispatch({ isError: true }),
      dispatch({ content: [{ type: 'text', text: '{not-json}' }] }),
      dispatch({ content: [{ type: 'image', attachment: {} as never }] }),
      dispatch({ content: [{ type: 'text', text: JSON.stringify(receipt({ sessionId: 'other-session' })) }] }),
      dispatch({ arguments: { names: ['beta_tool'] } }),
      dispatch({ content: [{ type: 'text', text: JSON.stringify(receipt({ selected: [{ name: 'alpha_tool', schemaHash: 'forged' }] })) }] }),
      dispatch({ content: [{ type: 'text', text: JSON.stringify(receipt({ requested: ['alpha_tool', 'alpha_tool'] })) }] }),
      dispatch({ content: [{ type: 'text', text: JSON.stringify(receipt({ selectedSdkBytes: 0 })) }] }),
    ]

    for (const candidate of failures) expect(parseReceipt(candidate, SESSION_ID)).toBeUndefined()
    expect(parseReceipt(valid, 'foreign-session')).toBeUndefined()
  })
})
