/** The kennel's thread list: every kennel conversation, the project each works in, and switching, renaming, archiving, and starting one. */
import { useMemo, useState } from 'react'
import type { SessionId, SessionListState, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { messageOf } from './HostStep.tsx'
import { kennelThreads, type KennelWorkspaces } from './kennel.ts'
import css from './KennelRoom.module.css'

/** What the thread list asks of the browser runtime. */
export interface KennelThreadActions {
  open: (threadId: SessionId) => void
  create: (workspaceId: WorkspaceId) => Promise<void>
  rename: (threadId: SessionId, title: string) => Promise<void>
  archive: (threadId: SessionId) => Promise<void>
}

/** Global hooks and actions the list reads and drives. */
export interface KennelThreadsProps {
  useSessions: SnapshotSelectorHook<SessionListState>
  useWorkspaces: SnapshotSelectorHook<KennelWorkspaces>
  actions: KennelThreadActions
}

/**
 * @param props - session and workspace hooks plus the thread actions.
 * @returns the "话题" section of the room's side column.
 */
export function KennelThreads({ useSessions, useWorkspaces, actions }: KennelThreadsProps) {
  const list = useSessions(state => state)
  const known = useWorkspaces(state => state)
  const threads = useMemo(() => kennelThreads(list, known), [list, known])
  const [chosen, setChosen] = useState<WorkspaceId>()
  const [renaming, setRenaming] = useState<{ id: SessionId; title: string }>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const projects = known.items
  const here = threads.find(thread => thread.current)
  const project = chosen ?? here?.workspaceId ?? known.recentWorkspaceId ?? projects[0]?.workspaceId
  const run = async (task: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await task()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }
  const archive = (id: SessionId): Promise<void> => run(async () => {
    const next = threads.find(thread => thread.id !== id)
    await actions.archive(id)
    if (here?.id === id && next !== undefined) actions.open(next.id)
  })
  return (
    <details open className={css.section}>
      <summary>话题</summary>
      {threads.length === 0 && <p className={css.empty}>还没有话题。选一个项目，点“新话题”。</p>}
      <ul className={css.threads} aria-label="狗窝话题">
        {threads.map(thread => (
          <li key={thread.id} className={css.thread}>
            {renaming?.id === thread.id
              ? (
                <form
                  className={css.renameThread}
                  onSubmit={(event) => {
                    event.preventDefault()
                    const title = renaming.title.trim()
                    if (title.length === 0) return
                    void run(async () => { await actions.rename(thread.id, title); setRenaming(undefined) })
                  }}
                >
                  <input aria-label="话题名称" value={renaming.title} autoFocus onChange={(event) => { setRenaming({ id: thread.id, title: event.target.value }) }} />
                  <Button size="sm" type="submit" disabled={busy}>保存</Button>
                  <Button size="sm" variant="ghost" onClick={() => { setRenaming(undefined) }}>取消</Button>
                </form>
              )
              : (
                <>
                  <button
                    type="button"
                    className={css.threadOpen}
                    aria-current={thread.current ? 'true' : undefined}
                    onClick={() => { if (!thread.current) actions.open(thread.id) }}
                  >
                    <strong>{thread.title === '' ? '新话题' : thread.title}</strong>
                    <span className={css.muted}>{thread.project}</span>
                  </button>
                  <Button size="sm" variant="ghost" aria-label={`重命名 ${thread.title === '' ? '新话题' : thread.title}`} disabled={busy} onClick={() => { setRenaming({ id: thread.id, title: thread.title }) }}>重命名</Button>
                  <Button size="sm" variant="ghost" aria-label={`归档 ${thread.title === '' ? '新话题' : thread.title}`} disabled={busy} onClick={() => { void archive(thread.id) }}>归档</Button>
                </>
              )}
          </li>
        ))}
      </ul>
      <div className={css.newThread}>
        <label className={css.muted}>
          项目
          <select value={project ?? ''} disabled={projects.length === 0 || busy} onChange={(event) => { setChosen(event.target.value as WorkspaceId) }}>
            {projects.length === 0 && <option value="">还没有工作区</option>}
            {projects.map(item => <option key={item.workspaceId} value={item.workspaceId}>{item.title}</option>)}
          </select>
        </label>
        <Button size="sm" disabled={busy || project === undefined} onClick={() => { if (project !== undefined) void run(() => actions.create(project)) }}>新话题</Button>
      </div>
      {error !== undefined && <p className={css.error} role="alert">{error}</p>}
    </details>
  )
}
