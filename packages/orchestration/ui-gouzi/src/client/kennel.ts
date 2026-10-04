/** Open the user's kennel conversation within the selected workspace. */
import type { ISessions, IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'

/** Preset id of the kennel session composition. */
export const KENNEL_PRESET = 'kennel'

/** What opening the kennel needs from the browser runtime. */
export interface KennelServices {
  readonly sessions: Pick<ISessions, 'list' | 'create' | 'open' | 'noteAgentPreset'>
  readonly workspaces: Pick<IWorkspaces, 'list'>
  readonly api: Pick<ConnectionHandle['api'], 'agentPresets'>
}

/**
 * Reuse the latest unarchived kennel conversation in the selected workspace, or create an independent one there.
 * The original session stays selected until the Host confirms the new session's kennel composition.
 * @param services - sessions, workspace membership, and the preset RPC.
 * @returns once the kennel session is current, or rejects without changing the current selection.
 */
export async function openKennel(services: KennelServices): Promise<void> {
  const { sessions, workspaces, api } = services
  const state = sessions.list.getSnapshot()
  const known = workspaces.list.getSnapshot()
  const target = known.items.find(item => state.current !== undefined && item.sessionIds.includes(state.current))
    ?? known.items.find(item => item.workspaceId === known.recentWorkspaceId)
    ?? [...known.items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  if (target === undefined) throw new Error('狗窝要在一个工作区里开始：请先在侧栏添加一个工作区')
  const existing = state.ids
    .map(id => state.byId[id])
    .filter(summary => summary !== undefined && summary.agentPreset === KENNEL_PRESET
      && target.sessionIds.includes(summary.id) && !known.archivedSessionIds.includes(summary.id))
    .sort((a, b) => (b?.updatedAt ?? 0) - (a?.updatedAt ?? 0))[0]
  if (existing !== undefined) {
    sessions.open(existing.id)
    return
  }
  const sessionId = await sessions.create({ workspaceId: target.workspaceId })
  const response = await api.agentPresets.select({ sessionId, agentPreset: KENNEL_PRESET })
  if (!response.result.ok) throw new Error(response.result.error.message)
  sessions.noteAgentPreset(sessionId, response.result.value.agentPreset)
  sessions.open(sessionId)
}
