/** Versioned research prompts and exact owner-scoped prepared model inputs. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ResearchRunId } from './action.ts'
import type { ResearchArtifactId } from './artifact.ts'

/** Immutable prepared input identity within one owned research run. */
export type ResearchPromptInputId = Branded<'ResearchPromptInputId'>

/** Original two-stage templates; model availability remains a separate actual observation. */
export type ResearchPromptId = 'gemini-deep-research' | 'chatgpt-verify-synthesize'

/** Original versioned template bytes decoded without normalization. */
export interface ResearchPromptTemplate {
  readonly id: ResearchPromptId
  readonly version: string
  readonly sourceName: string
  readonly sha256: string
  readonly text: string
}

/** Host text or an exact owner-readable immutable artifact; neither grants execution authority. */
export type ResearchPromptPart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'artifact'; readonly artifactId: ResearchArtifactId; readonly sha256: string }

/** Explicit slot values; absence never becomes an invented fact or a silent default. */
export interface ResearchPromptPreparation {
  readonly inputId: ResearchPromptInputId
  readonly revision: number
  readonly templateId: ResearchPromptId
  readonly values: Readonly<Record<string, readonly ResearchPromptPart[]>>
}

/** Exact retained slot bytes with the original artifact version when applicable. */
export type ResearchRetainedPromptPart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'artifact'
    readonly artifactId: ResearchArtifactId
    readonly version: number
    readonly sha256: string
    readonly text: string }

/** Full template, all values and exact rendered input; local retention is not website receipt evidence. */
export interface ResearchPreparedPrompt {
  readonly inputId: ResearchPromptInputId
  readonly runId: ResearchRunId
  readonly revision: number
  readonly questionSha256: string
  readonly template: ResearchPromptTemplate
  readonly values: Readonly<Record<string, readonly ResearchRetainedPromptPart[]>>
  readonly renderedText: string
  readonly renderedSha256: string
  readonly preparedAt: string
}
