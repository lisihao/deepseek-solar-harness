import type { ChatGptPageObservation } from './page-observation.js'
import type { WebRunRequest, WebRunResource } from './store.js'

/** Trusted plugin API only; model-facing callers cannot provide executable code. */
export interface WebBrowserAdapter {
  create(runId: string, signal?: AbortSignal): Promise<WebRunResource>
  prepare(resource: WebRunResource, request: WebRunRequest, signal?: AbortSignal): Promise<ChatGptPageObservation>
  observe(resource: WebRunResource, signal?: AbortSignal): Promise<ChatGptPageObservation>
  /** Exactly one submit attempt. The controller journals submission-unknown before this call. */
  submit(resource: WebRunResource, request: WebRunRequest, signal?: AbortSignal): Promise<ChatGptPageObservation>
  finish(resource: WebRunResource): Promise<void>
}

export class WebBrowserError extends Error {
  constructor(readonly code: string, message: string, readonly mayHaveLateEffects?: boolean) { super(message); this.name = 'WebBrowserError' }
}
