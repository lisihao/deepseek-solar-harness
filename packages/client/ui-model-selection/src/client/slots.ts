/**
 * ModelSelect's injected face. The target 'conversation.input.model' seat is
 * declared (children table) and typed by ui-conversation's composer-bar
 * entry; this package only contributes the single occupant, so no SlotMap
 * merge lives here.
 */
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the per-message action strip).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ModelDirectoryState } from './directory.ts'
import type { ModelRefreshReport } from './service.ts'

/** Injected business face of the composer model seat. */
export interface ModelSelectInjected {
  /** Whether this session supports Agent-bound model inspection and selection. */
  available: boolean
  /** The session's shared directory store (same instance the /model popup reads). */
  directory: SnapshotStore<ModelDirectoryState>
  /** Refresh the advisory directory (fire-and-forget; errors land on the store). */
  load: () => void
  /**
   * Refresh live provider catalogs and every registered model source.
   * @returns newly listed models and per-catalog outcomes.
   */
  refresh: () => Promise<ModelRefreshReport>
  /**
   * Select a complete provider/model/reasoning selection.
   * @param selection - model selection and optional adapter-owned effort.
   * @returns whether the host accepted the selection.
   */
  select: (selection: ModelSelection) => Promise<boolean>
}

/**
 * Injected face of the served-by caption. The caption sits in ui-conversation's per-message action strip
 * (`conversation.chat.assistant-actions`), which declares and types the slot; this package contributes one entry and
 * reads the session's directory through a hook to turn model ids into display names.
 */
export interface ServedByInjected {
  hooks: {
    /** The session's shared directory (the same instance the menu reads). */
    directory: HostObservable<ModelDirectoryState>
  }
}

/** Full props of the served-by caption entry. */
export type ServedByProps =
  PropsRuntime<'conversation.chat.assistant-actions'>
  & InjectFace<ServedByInjected>
  & PropsLocale<'model'>
