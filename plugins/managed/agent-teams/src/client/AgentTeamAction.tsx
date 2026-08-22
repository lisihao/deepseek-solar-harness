import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './AgentTeamAction.module.css'

export type AgentTeamActionProps = PropsRuntime<'conversation.session.header.actions'>

function teamPrompt(task: string): string {
  return `请为下面的任务启动 Agent Team。先由主模型拆分方案，再并行委派给范围明确的成员，汇总并验证全部结果：\n\n${task}`
}

/** Session-local launcher that starts an Agent Team without a slash command. */
export function AgentTeamAction({ inputActions }: AgentTeamActionProps) {
  const [open, setOpen] = useState(false)
  const [task, setTask] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => { document.removeEventListener('pointerdown', closeOutside) }
  }, [open])

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const objective = task.trim()
    if (objective === '') return
    inputActions.setDraft(teamPrompt(objective))
    inputActions.submit()
    setTask('')
    setOpen(false)
  }

  return (
    <div className={css.root} ref={rootRef}>
      <button
        type="button"
        className={css.trigger}
        aria-expanded={open}
        title="启动 Agent Team"
        onClick={() => { setOpen(value => !value) }}
      >
        Agent Team
      </button>
      {open && (
        <form className={css.popover} onSubmit={submit}>
          <label className={css.label} htmlFor="agent-team-objective">团队任务</label>
          <textarea
            id="agent-team-objective"
            className={css.input}
            rows={4}
            autoFocus
            placeholder="描述要并行完成并由主模型验收的任务"
            value={task}
            onChange={event => { setTask(event.target.value) }}
          />
          <div className={css.actions}>
            <button type="button" className={css.cancel} onClick={() => { setOpen(false) }}>取消</button>
            <button type="submit" className={css.submit} disabled={task.trim() === ''}>启动团队</button>
          </div>
        </form>
      )}
    </div>
  )
}
