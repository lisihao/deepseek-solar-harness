import { renderToolsSdk, type PtcDispatchEventData } from '@deepseek-ai/dsh-tools'
import { catalogRevision, toolRevision, type CatalogEntry } from './catalog.js'

export const SEARCH_NAME = 'solar_tool_search'
export const LOAD_NAME = 'solar_tool_load'
export const DISCOVERY_NOTICE = 'Tool descriptions are available on demand. Use solar_tool_search with relevant keywords, then solar_tool_load with exact returned names. Loading changes descriptions only and never executes a business tool. Complete selected argument and output schemas appear in the next request; inspect them before constructing calls. Search pages support nextOffset. Evicted descriptions may be loaded again. All allowed tools remain callable through the original tools bindings and original permission checks; search/load do not grant permission.'

export interface SelectedTool { name: string; schemaHash: string }
export interface SelectionLimits { maxLoadedTools: number; maxLoadedBytes: number }
export interface LoadReceipt {
  formatVersion: 1
  kind: 'solar-tool-context-load'
  sessionId: string
  registryRevision: string
  requested: string[]
  selected: SelectedTool[]
  evictedNames: string[]
  selectedSdkBytes: number
}
export type ProgramFormat = 'function-body' | 'repl'

export function renderSelection(entries: readonly CatalogEntry[], selected: readonly SelectedTool[], format: ProgramFormat): string {
  const selectedNames = new Set(selected.filter(item => entries.some(entry => entry.name === item.name && toolRevision(entry) === item.schemaHash)).map(item => item.name))
  const schemas = entries.filter(entry => entry.name === SEARCH_NAME || entry.name === LOAD_NAME || selectedNames.has(entry.name))
  return `${DISCOVERY_NOTICE}\n\n${renderToolsSdk([...schemas], format)}`
}

export function validSelection(entries: readonly CatalogEntry[], selected: readonly SelectedTool[], limits: SelectionLimits, format: ProgramFormat): SelectedTool[] {
  if (Buffer.byteLength(renderSelection(entries, [], format)) > limits.maxLoadedBytes) throw new Error('TOOL_CONTEXT_SCHEMA_TOO_LARGE: discovery declarations alone exceed the SDK budget')
  const retained = selected.filter(item => entries.some(entry => entry.name === item.name && toolRevision(entry) === item.schemaHash))
  while (retained.length > limits.maxLoadedTools || Buffer.byteLength(renderSelection(entries, retained, format)) > limits.maxLoadedBytes) retained.shift()
  return retained
}

export function makeReceipt(sessionId: string, entries: readonly CatalogEntry[], previous: readonly SelectedTool[], names: readonly string[], limits: SelectionLimits, format: ProgramFormat): LoadReceipt {
  if (names.length < 1 || names.length > limits.maxLoadedTools || new Set(names).size !== names.length || names.some(name => typeof name !== 'string' || name.length === 0 || name === SEARCH_NAME || name === LOAD_NAME)) {
    throw new Error('TOOL_CONTEXT_LOAD_INVALID: use distinct exact business-tool names within maxLoadedTools')
  }
  let selected = validSelection(entries, previous, limits, format)
  const original = selected.map(item => item.name)
  for (const name of names) {
    const entry = entries.find(item => item.name === name)
    if (!entry) throw new Error(`TOOL_CONTEXT_TOOL_UNAVAILABLE: ${name} is not available in the caller scope`)
    selected = selected.filter(item => item.name !== name)
    selected.push({ name, schemaHash: toolRevision(entry) })
  }
  // Never silently evict a member of this load request. The user/model can
  // request a smaller group; no argument/output schema is ever truncated.
  while (selected.length > limits.maxLoadedTools || Buffer.byteLength(renderSelection(entries, selected, format)) > limits.maxLoadedBytes) {
    if (names.includes(selected[0]!.name)) throw new Error('TOOL_CONTEXT_SCHEMA_TOO_LARGE: the requested complete declarations exceed the SDK budget; request fewer tools or increase the plugin budget')
    selected.shift()
  }
  return {
    formatVersion: 1, kind: 'solar-tool-context-load', sessionId,
    registryRevision: catalogRevision(entries.filter(entry => entry.name !== SEARCH_NAME && entry.name !== LOAD_NAME)), requested: [...names], selected,
    evictedNames: original.filter(name => !selected.some(item => item.name === name)),
    selectedSdkBytes: Buffer.byteLength(renderSelection(entries, selected, format)),
  }
}

/** Parse only an accepted, named PTC tool outcome; arbitrary message text is never a receipt. */
export function parseReceipt(data: PtcDispatchEventData, sessionId: string): LoadReceipt | undefined {
  if (data.name !== LOAD_NAME || data.isError || data.content.length !== 1 || data.content[0]?.type !== 'text') return
  let value: unknown
  try { value = JSON.parse(data.content[0].text) } catch { return }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const r = value as Record<string, unknown>
  const args = data.arguments as { names?: unknown } | null
  if (r.formatVersion !== 1 || r.kind !== 'solar-tool-context-load' || r.sessionId !== sessionId
    || typeof r.registryRevision !== 'string' || !/^[a-f0-9]{64}$/.test(r.registryRevision)
    || !Array.isArray(r.requested) || r.requested.length === 0 || !r.requested.every(name => typeof name === 'string' && name.length > 0)
    || new Set(r.requested).size !== r.requested.length
    || !args || JSON.stringify(args.names) !== JSON.stringify(r.requested)
    || !Array.isArray(r.selected) || !r.selected.every(item => item && typeof item === 'object' && typeof item.name === 'string' && typeof item.schemaHash === 'string' && /^[a-f0-9]{64}$/.test(item.schemaHash))
    || new Set(r.selected.map(item => item.name)).size !== r.selected.length
    || !Array.isArray(r.evictedNames) || !r.evictedNames.every(name => typeof name === 'string')
    || !Number.isSafeInteger(r.selectedSdkBytes) || (r.selectedSdkBytes as number) < 1) return
  return value as LoadReceipt
}
