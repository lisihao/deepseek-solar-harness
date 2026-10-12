/**
 * The kennel's own conversation space: every kennel conversation is a thread, listed by the kennel and withheld from
 * the workspace lists. A thread still belongs to a project (a Workspace), because the room checks which projects a dog
 * may work in against the conversation's directory.
 */
import type { ISessions, IWorkspaces, SessionId, SessionListState, WorkspaceId, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'

/** Preset id of the kennel session composition. */
export const KENNEL_PRESET = 'kennel'

/** Longest wait for the kennel to open before the user is told it did not, in milliseconds. */
export const KENNEL_OPEN_TIMEOUT_MS = 20_000

/** What opening or creating a kennel thread needs from the browser runtime. */
export interface KennelServices {
  readonly sessions: Pick<ISessions, 'list' | 'create' | 'open' | 'noteAgentPreset'>
  readonly workspaces: Pick<IWorkspaces, 'list'>
  readonly api: Pick<ConnectionHandle['api'], 'agentPresets'>
}

/** One kennel conversation as the thread list shows it. */
export interface KennelThread {
  readonly id: SessionId
  /** The conversation's title; empty until it has one. */
  readonly title: string
  readonly workspaceId: WorkspaceId | undefined
  /** The project the thread works in. */
  readonly project: string
  readonly updatedAt: number
  readonly current: boolean
}

/** The slice of the Workspace list the kennel reads. */
export type KennelWorkspaces = Pick<WorkspaceListState, 'items' | 'archivedSessionIds' | 'recentWorkspaceId'>

/** Last path segment of a directory, for a project label when the Workspace is unknown. */
function directoryName(cwd: string | undefined): string {
  const base = cwd?.replace(/[/\\]+$/u, '').split(/[/\\]/u).pop()
  return base === undefined || base === '' ? '未归入工作区' : base
}

/**
 * Every unarchived kennel conversation, newest first. A thread nobody has written in yet is listed only while it is the
 * current one, so an abandoned "new thread" does not stay behind.
 * @param list - sessions list snapshot.
 * @param known - Workspace list snapshot.
 * @returns the threads, most recently updated first.
 */
export function kennelThreads(list: SessionListState, known: KennelWorkspaces): KennelThread[] {
  const archived = new Set(known.archivedSessionIds)
  const threads: KennelThread[] = []
  for (const id of list.ids) {
    const summary = list.byId[id]
    if (summary?.agentPreset !== KENNEL_PRESET || summary.origin === 'subagent' || archived.has(id)) continue
    if (summary.blank && id !== list.current) continue
    const workspace = known.items.find(item => item.sessionIds.includes(id))
    threads.push({
      id,
      title: summary.blank ? '' : summary.displayTitle,
      workspaceId: workspace?.workspaceId,
      project: workspace?.title ?? directoryName(summary.cwd),
      updatedAt: summary.updatedAt,
      current: id === list.current,
    })
  }
  return threads.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1))
}

/** What {@link openKennel} did. */
export type OpenKennelResult =
  | { readonly kind: 'already'; readonly threadId: SessionId }
  | { readonly kind: 'opened'; readonly threadId: SessionId }
  | { readonly kind: 'created'; readonly threadId: SessionId }

/**
 * Create a kennel thread in a project and make it current. The conversation stays hidden from the workspace lists, so
 * the current selection only changes once the Host has confirmed the kennel composition.
 * @param services - sessions, workspace membership, and the preset RPC.
 * @param workspaceId - the project the thread works in.
 * @returns the new thread's id once it is current.
 * @throws Error - when the conversation cannot be created or the Host refuses the kennel composition.
 */
export async function createKennelThread(services: KennelServices, workspaceId: WorkspaceId): Promise<SessionId> {
  const { sessions, api } = services
  const sessionId = await sessions.create({ workspaceId })
  const response = await api.agentPresets.select({ sessionId, agentPreset: KENNEL_PRESET })
  if (!response.result.ok) throw new Error(response.result.error.message)
  sessions.noteAgentPreset(sessionId, response.result.value.agentPreset)
  sessions.open(sessionId)
  return sessionId
}

/**
 * Enter the kennel. Inside a kennel thread nothing changes and the result says so; elsewhere the most recently updated
 * thread opens, whatever project it is in; with no thread yet, the first is created in the project of the current
 * conversation, then the recent project, then the newest one.
 * @param services - sessions, workspace membership, and the preset RPC.
 * @returns what happened, once the thread is current.
 * @throws Error - when there is no project to start in, or the thread cannot be created.
 */
export async function openKennel(services: KennelServices): Promise<OpenKennelResult> {
  const { sessions, workspaces } = services
  const state = sessions.list.getSnapshot()
  const known = workspaces.list.getSnapshot()
  const threads = kennelThreads(state, known)
  const current = threads.find(thread => thread.current)
  if (current !== undefined) return { kind: 'already', threadId: current.id }
  const latest = threads[0]
  if (latest !== undefined) {
    sessions.open(latest.id)
    return { kind: 'opened', threadId: latest.id }
  }
  const target = known.items.find(item => state.current !== undefined && item.sessionIds.includes(state.current))
    ?? known.items.find(item => item.workspaceId === known.recentWorkspaceId)
    ?? [...known.items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  if (target === undefined) throw new Error('狗窝要在一个工作区里开始：请先在侧栏添加一个工作区')
  return { kind: 'created', threadId: await createKennelThread(services, target.workspaceId) }
}
