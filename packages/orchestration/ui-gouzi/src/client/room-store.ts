/** Interaction state shared by all three room slots. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { KennelRecipient } from '../recipient-message.ts'
/** Independent transcript filter and send target. */
export interface KennelRoomState {
  filter: string
  recipient: KennelRecipient | null
  draft: string
  expandedEvidence: Record<string, boolean>
  sentNotice: { label: string; target: string } | null
}
/** Declared room interaction actions carried by the registration handle. */
type KennelRoomActions = {
  filter: (draft: KennelRoomState, filter: string) => void
  recipient: (draft: KennelRoomState, recipient: KennelRecipient | null) => void
  draft: (state: KennelRoomState, draft: string) => void
  evidence: (draft: KennelRoomState, key: string) => void
  sent: (draft: KennelRoomState, text: string, label: string, target: string) => void
}

/**
 * Declare the room's shared transcript filter, recipient, draft, and evidence state.
 * @returns a fresh registration handle with session-scoped interaction actions.
 */
export function createKennelRoomStore(): EngineStoreHandle<KennelRoomState, KennelRoomActions> {
  return defineStore({
    init: (): KennelRoomState => ({ filter: 'all', recipient: null, draft: '', expandedEvidence: {}, sentNotice: null }),
    actions: {
      filter: (d, filter: string) => { d.filter = filter },
      recipient: (d, recipient: KennelRecipient | null) => { d.recipient = recipient },
      draft: (d, draft: string) => { d.draft = draft },
      evidence: (d, key: string) => { d.expandedEvidence[key] = !d.expandedEvidence[key] },
      sent: (d, text: string, label: string, target: string) => { if (d.draft === text) d.draft = ''; d.sentNotice = { label, target } },
    },
  })
}
/** Store handle type used by registration and components. */
export type KennelRoomStore = ReturnType<typeof createKennelRoomStore>
