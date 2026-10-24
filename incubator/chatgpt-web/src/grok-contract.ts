export interface GrokResource {
  readonly provider: 'grok'
  readonly spaceId: number
  readonly pageLabel: string
  readonly conversationUrl: string
}

export interface GrokMessageObservation {
  readonly id: string
  readonly role: 'user' | 'assistant'
  /** Visible body only: no hidden headings, thinking, buttons, Canvas or media. */
  readonly text: string
  readonly hasCopyControl: boolean
  readonly hasArtifacts: boolean
}

export interface GrokPageObservation {
  readonly url: string
  readonly authenticated: boolean
  readonly loginRequired: boolean
  readonly challenge: boolean
  readonly busy: boolean | undefined
  readonly composerCount: number
  readonly composerText: string
  readonly submitCount: number
  readonly submitEnabled: boolean
  readonly modelLabel: string | undefined
  readonly messages: readonly GrokMessageObservation[]
  readonly errors: readonly string[]
}

export interface GrokBrowserPort {
  allocate(input: { readonly id: string; readonly sessionId: string }, signal?: AbortSignal): Promise<GrokResource>
  /** Populate a fresh empty page and verify exact model/composer text; do not submit. */
  prepare(resource: GrokResource, input: { readonly prompt: string; readonly modelLabel?: string }, signal?: AbortSignal): Promise<GrokPageObservation>
  /** Exactly one click; the controller must have committed its intent first. */
  submit(resource: GrokResource, signal?: AbortSignal): Promise<void>
  /** Read the same original page. Never fill, submit, regenerate, select a different answer or replace the page. */
  observe(resource: GrokResource, signal?: AbortSignal): Promise<GrokPageObservation>
  finish(resource: GrokResource): Promise<void>
}

export interface GrokRequest {
  readonly id: string
  readonly sessionId: string
  readonly canonical: string
  readonly prompt: string
  readonly modelLabel?: string
}

export type GrokStage = 'created' | 'preparing' | 'prepared' | 'submission-unknown' | 'submitted' | 'completed' | 'blocked' | 'failed' | 'indeterminate' | 'cancelled'

export interface GrokRunRecord {
  readonly formatVersion: 1
  readonly revision: number
  readonly id: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly request: GrokRequest
  readonly stage: GrokStage
  readonly resource?: GrokResource
  readonly observedModelLabel?: string
  readonly intentAt?: string
  readonly promptReceiptId?: string
  readonly replyId?: string
  readonly output?: { readonly text: string; readonly sha256: string }
  readonly error?: { readonly code: string; readonly message: string }
}

export interface GrokExecutionPort {
  start(request: GrokRequest, signal?: AbortSignal): Promise<GrokRunRecord>
  observe(id: string, signal?: AbortSignal): Promise<GrokRunRecord>
  read(id: string): Promise<GrokRunRecord | undefined>
}
