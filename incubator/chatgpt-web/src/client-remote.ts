import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { WebRunRecord } from './store.js'
import type {
  ChatGptWebControlApi,
  WebIdInput,
  WebLaunchInput,
  WebUiStatus,
} from './ui-contract.js'

/** The wire-facing shape returned by the rc.2 Client Remote carrier. */
export interface WebUiWire {
  status(): Promise<RemoteResult<WebUiStatus>>
  launch(input: WebLaunchInput): Promise<RemoteResult<{ readonly id: string }>>
  observe(input: WebIdInput): Promise<RemoteResult<WebRunRecord>>
  cancel(input: WebIdInput): Promise<RemoteResult<WebRunRecord>>
}

/**
 * Unwrap one official Remote carrier result without converting its failure
 * into a generic success value. Remote failures are already Error instances
 * carrying their stable `code` and diagnostic `message`; throwing that same
 * object lets the UI's existing error path preserve both fields.
 */
export function unwrapWebRemote<T>(result: RemoteResult<T>): T {
  if (result.ok) return result.value
  throw result.error
}

/** Adapt the wire result envelope to the plain server-side UI contract. */
export function createWebUiApi(wire: WebUiWire): ChatGptWebControlApi {
  return {
    status: async () => unwrapWebRemote(await wire.status()),
    launch: async input => unwrapWebRemote(await wire.launch(input)),
    observe: async input => unwrapWebRemote(await wire.observe(input)),
    cancel: async input => unwrapWebRemote(await wire.cancel(input)),
  }
}
