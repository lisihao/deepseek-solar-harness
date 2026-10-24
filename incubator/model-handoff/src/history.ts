type JsonRecord = Record<string, unknown>

const CONTEXT_FORMS = new Set(['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall'])
const AUTOMATIC_FORMS = new Set(['instructions', 'catalog', 'snapshot', 'recall'])
const OPAQUE_USER_KINDS = new Set([
  'plugin:hindsight',
  'dsh-mnemon',
  'time-context',
  'runtime-context',
  'skill-catalog',
])
const AUTOMATIC_KINDS = new Set([
  'environment',
  'context',
  'environment-context',
  'context-catalog',
  'session-reference',
  'skill-invocation',
])

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function copyJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copyJson)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, copyJson(entry)]))
}

function sourceOf(record: JsonRecord): JsonRecord | undefined {
  return isRecord(record.source) ? record.source : undefined
}

function sourceKind(source: JsonRecord | undefined): string | undefined {
  return typeof source?.kind === 'string' ? source.kind : undefined
}

function sourceForm(source: JsonRecord | undefined): string | undefined {
  return typeof source?.form === 'string' && CONTEXT_FORMS.has(source.form) ? source.form : undefined
}

function isAutomaticContext(record: JsonRecord, source: JsonRecord | undefined): boolean {
  const form = sourceForm(source)
  const kind = sourceKind(source)?.toLowerCase()
  if (record.role === 'system' || kind === 'system-prompt') return true
  // Assistant, tool, and developer records are task history even when a
  // producer happens to annotate them with a context form. In particular,
  // developer tool-definition changes must remain paired with their header.
  if (record.role !== 'user') return false
  if (kind !== undefined && AUTOMATIC_KINDS.has(kind)) return true
  return form !== undefined && AUTOMATIC_FORMS.has(form)
}

function isOpaqueUserSource(source: JsonRecord | undefined): boolean {
  const kind = sourceKind(source)
  return kind !== undefined && OPAQUE_USER_KINDS.has(kind.toLowerCase())
}

/**
 * Keep only the small, durable attribution needed to understand a task record.
 * Provider replay state and producer-owned context payloads deliberately stay
 * outside this representation.
 */
function normalizeSource(source: JsonRecord | undefined): JsonRecord | undefined {
  const kind = sourceKind(source)
  if (kind === undefined) return undefined

  const normalized: JsonRecord = { kind }
  const form = sourceForm(source)
  if (form !== undefined) normalized.form = form
  if (kind === 'model') {
    if (typeof source?.provider === 'string') normalized.provider = source.provider
    if (typeof source?.model === 'string') normalized.model = source.model
  } else if (kind === 'tool' && typeof source?.callId === 'string') {
    normalized.callId = source.callId
  } else if (kind === 'compact-checkpoint' && typeof source?.compactionId === 'string') {
    normalized.compactionId = source.compactionId
  }
  return normalized
}

function hasToolAddition(record: JsonRecord): boolean {
  return Array.isArray(record.content) && record.content.some((block) => (
    isRecord(block) && block.type === 'tool-addition'
  ))
}

function shouldRetain(record: JsonRecord): boolean {
  const source = sourceOf(record)
  const kind = sourceKind(source)
  const role = record.role

  // Request audit envelopes repeat the complete operator input and canonical
  // identity. Keep the original log, but do not treat that copy as task facts.
  if (role === 'user' && kind === 'solar-web-context' && sourceForm(source) === 'notice'
    && Array.isArray(record.content) && record.content.length === 1) {
    const block = record.content[0]
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      try {
        const audit: unknown = JSON.parse(block.text)
        if (isRecord(audit) && (audit.kind === 'grok-request' || audit.kind === 'web-request')) return false
      } catch { /* Unknown notices remain attributed task context. */ }
    }
  }

  if (isAutomaticContext(record, source)) return false
  if (role === 'assistant' || role === 'tool' || role === 'developer') return true
  if (role !== 'user') return false
  if (isOpaqueUserSource(source)) return false
  if (kind === 'user' || kind === 'compact-checkpoint') return true
  // A notice or relay is a producer-authored task context item. It remains
  // visible, but rendering labels it as context rather than as authorization.
  const form = sourceForm(source)
  return form === 'notice' || form === 'relay'
}

function projectRecord(record: JsonRecord): JsonRecord {
  const projected: JsonRecord = {}
  for (const key of ['seq', 'type', 'role', 'content'] as const) {
    if (Object.hasOwn(record, key)) projected[key] = key === 'content' ? copyJson(record[key]) : record[key]
  }

  const source = normalizeSource(sourceOf(record))
  if (source !== undefined) projected.source = source

  if (Object.hasOwn(record, 'toolCallId')) projected.toolCallId = record.toolCallId
  if (Object.hasOwn(record, 'isError')) projected.isError = record.isError

  // request/header data is only needed to resolve a developer tool-addition;
  // keeping it on unrelated records would retain stale or oversized metadata.
  if ((record.role === 'developer' || record.type === 'developer/message')
    && hasToolAddition(record)
    && Object.hasOwn(record, 'toolHeader')) {
    projected.toolHeader = copyJson(record.toolHeader)
  }
  return projected
}

/**
 * Project source() records to task history while preserving order and exact
 * message blocks. The returned records are detached copies.
 */
export function projectTaskRecords(records: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return records.filter(shouldRetain).map(projectRecord)
}

function blockText(block: unknown): string {
  if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') return block.text
  const serialized = JSON.stringify(block)
  return serialized === undefined ? String(block) : serialized
}

function labelFor(record: JsonRecord): string {
  const role = typeof record.role === 'string' ? record.role : 'unknown'
  const source = sourceOf(record)
  const form = sourceForm(source)
  if (source?.kind === 'compact-checkpoint') return '历史交接摘要'
  if (role === 'user' && (form === 'notice' || form === 'relay')) return `上下文（${form}）`
  switch (role) {
    case 'user': return '用户'
    case 'assistant': return '模型'
    case 'tool': return '工具'
    case 'developer': return '开发者'
    default: return '消息'
  }
}

function renderRecord(record: JsonRecord): string {
  const content = Array.isArray(record.content) ? record.content.map(blockText) : [blockText(record.content)]
  const label = `${labelFor(record)}：`
  if (content.length === 0) return label
  return label + content.join('\n')
}

/**
 * Render projected task messages for a model without exposing internal
 * sequence, hash, or source metadata. Text blocks remain byte-for-byte text;
 * every other block is represented as JSON.
 */
export function renderTaskTranscript(records: readonly Record<string, unknown>[]): string {
  return projectTaskRecords(records).map(renderRecord).join('\n')
}

/** Count Unicode code points rather than UTF-16 code units. */
export function textLength(text: string): number {
  return Array.from(text).length
}
