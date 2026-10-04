/** Open the kennel: the user's chat with the dogs, a session composed from the `kennel` agent preset. */
import type { ISessions, IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'

/** Preset id of the kennel session composition. */
export const KENNEL_PRESET = 'kennel'

/** Longest wait for the blank session a new start produces, in milliseconds. */
const START_TIMEOUT_MS = 15_000

/** What opening the kennel needs from the browser runtime. */
export interface KennelServices {
  readonly sessions: Pick<ISessions, 'list' | 'open' | 'noteAgentPreset'>
  readonly workspaces: Pick<IWorkspaces, 'list' | 'startSession'>
  readonly api: Pick<ConnectionHandle['api'], 'agentPresets'>
}

/**
 * Open the kennel session, creating it when there is none. An existing one is reused so the dogs and the user keep
 * one running conversation; a new one starts in the current workspace and takes the preset while it is still
 * blank, because the host refuses to change the preset of a session that has history.
 * @param services - sessions, workspaces, and the preset RPC.
 * @returns once the kennel session is current, or rejects with the reason it could not be.
 */
export async function openKennel(services: KennelServices): Promise<void> {
  const { sessions, workspaces, api } = services
  const state = sessions.list.getSnapshot()
  const existing = state.ids
    .map(id => state.byId[id])
    .filter(summary => summary?.agentPreset === KENNEL_PRESET)
    .sort((a, b) => (b?.updatedAt ?? 0) - (a?.updatedAt ?? 0))[0]
  if (existing !== undefined) {
    sessions.open(existing.id)
    return
  }
  // Starting with no target inherits the current session's workspace; with no current session there is nothing to
  // inherit, and the runtime does not guess, so the most recently used workspace (else the newest) is named here.
  if (state.current === undefined) {
    const known = workspaces.list.getSnapshot()
    const target = known.items.find(item => item.workspaceId === known.recentWorkspaceId)
      ?? [...known.items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
    if (target === undefined) throw new Error('狗窝要在一个工作区里开始：请先在侧栏添加一个工作区')
    workspaces.startSession(target.workspaceId)
  } else {
    workspaces.startSession()
  }
  const blank = await currentBlankSession(sessions.list)
  const response = await api.agentPresets.select({ sessionId: blank, agentPreset: KENNEL_PRESET })
  if (!response.result.ok) throw new Error(response.result.error.message)
  sessions.noteAgentPreset(blank, response.result.value.agentPreset)
}

type SessionId = NonNullable<ReturnType<KennelServices['sessions']['list']['getSnapshot']>['current']>

function currentBlankSession(list: KennelServices['sessions']['list']): Promise<SessionId> {
  return new Promise<SessionId>((resolveSession, rejectSession) => {
    const check = (): boolean => {
      const state = list.getSnapshot()
      const summary = state.current === undefined ? undefined : state.byId[state.current]
      if (summary === undefined || !summary.blank) return false
      stop()
      clearTimeout(timer)
      resolveSession(summary.id)
      return true
    }
    const stop = list.subscribe(() => { check() })
    const timer = setTimeout(() => {
      stop()
      rejectSession(new Error('没能新建狗窝会话：工作区没有响应，请稍后再试'))
    }, START_TIMEOUT_MS)
    check()
  })
}
