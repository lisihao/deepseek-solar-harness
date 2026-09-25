import type { JsonValue } from '@deepseek-ai/dsh-session'

export const ARCHIFY_DIAGRAM_TYPES = [
  'architecture',
  'workflow',
  'sequence',
  'dataflow',
  'lifecycle',
] as const

export type ArchifyDiagramType = typeof ARCHIFY_DIAGRAM_TYPES[number]

export const ARCHIFY_ACTIONS = [
  'render',
  'validate',
  'deliver',
  'compare',
  'inspect',
  'guide',
  'doctor',
  'visual-check',
  'examples',
  'brands',
  'migrate',
] as const

export type ArchifyAction = typeof ARCHIFY_ACTIONS[number]
export type ArchifyQuality = 'standard' | 'showcase'

export interface ArchifyToolArgs {
  action: ArchifyAction
  type?: ArchifyDiagramType
  input?: JsonValue
  baseInput?: JsonValue
  headInput?: JsonValue
  quality?: ArchifyQuality
  repoRoot?: string
  outputName?: string
  htmlPath?: string
  scenario?: string
  language?: 'en' | 'zh'
  query?: string
  captureUrl?: string
  migrateToSchema?: '2'
}

export interface ArchifyArtifactRef {
  readonly ref: `sha256:${string}`
  readonly kind: 'html' | 'json' | 'receipt' | 'diagnostic'
  readonly bytes: number
  readonly path: string
}

export interface ArchifyError {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
}

export interface ArchifyToolResult {
  readonly schemaVersion: 1
  readonly ok: boolean
  readonly action: ArchifyAction
  readonly type?: ArchifyDiagramType
  readonly upstream: {
    readonly repository: string
    readonly tag: string
    readonly commit: string
  }
  readonly summary?: string
  readonly artifactRef?: ArchifyArtifactRef
  readonly deliveryPath?: string
  readonly upstreamReceipt?: JsonValue
  readonly upstreamReceiptRef?: ArchifyArtifactRef
  readonly diagnostics?: JsonValue
  readonly receiptRef: `sha256:${string}`
  readonly error?: ArchifyError
}
