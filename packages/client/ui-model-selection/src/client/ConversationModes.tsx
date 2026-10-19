/** Mutually exclusive composer modes projected from the actual Host model selection. */
import { useEffect, useId } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { isChatGptWebSelection, type ModelDirectoryState } from './directory.ts'
import css from './ConversationModes.module.css'

/** Private injected mode controls; the framework binds the directory observable. */
export interface ConversationModesInjected {
  readonly available: boolean
  readonly hooks: { readonly directory: ObservableSnapshot<ModelDirectoryState> }
  readonly load: () => void
  readonly selectMode: (mode: 'ordinary' | 'chatgpt') => Promise<void>
}

/** @param props - Actual Session/input state and shared model-directory controls. @returns The input-below mode row. */
export function ConversationModes({ available, useDirectory, load, selectMode, session, input }:
  PropsRuntime<'conversation.composer.controls'> & InjectFace<ConversationModesInjected>) {
  const state = useDirectory(s => s), name = useId()
  useEffect(() => { if (available) load() }, [available, load])
  if (!available) return null
  const interactionLocked = session.removed || session.running || input.phase === 'adjudicating' || input.phase === 'submitting'
    || state.status === 'selecting' || state.conversationModePending === true
  const busy = interactionLocked || state.current === null
  const loadingDirectory = state.current === null && state.status === 'loading'
  const directoryError = state.current === null ? state.error : null
  const web = isChatGptWebSelection(state.current)
  const choose = (mode: 'ordinary' | 'chatgpt') => {
    if (!busy) void selectMode(mode).catch(() => { /* The directory retains the visible error and composer block. */ })
  }
  return (
    <div className={css.root}>
      <div className={css.options} role="radiogroup" aria-label="对话模式">
        <label><input type="radio" name={name} checked={state.current !== null && !web} disabled={busy}
          onChange={() => { choose('ordinary') }}
          onClick={() => { if (!web && state.conversationModeError !== undefined) choose('ordinary') }} />普通对话</label>
        <label><input type="radio" name={name} checked={web} disabled={busy}
          onChange={() => { choose('chatgpt') }}
          onClick={() => { if (web && state.conversationModeError !== undefined) choose('chatgpt') }} />ChatGPT</label>
        <label className={css.unavailable} title="洞察尚未完成，暂不可用">
          <input type="radio" name={name} checked={false} disabled aria-label="洞察" readOnly />洞察
          <span>暂不可用</span>
        </label>
      </div>
      {loadingDirectory && <span role="status">正在读取对话模式…</span>}
      {directoryError !== null && <span role="alert">对话模式读取失败：{directoryError}</span>}
      {(directoryError !== null || loadingDirectory) && <button type="button"
        disabled={interactionLocked || loadingDirectory}
        onClick={() => { if (!interactionLocked && !loadingDirectory) load() }}>重新读取对话模式</button>}
      {state.conversationModePending === true && <span role="status">正在切换对话模式…</span>}
      {state.conversationModeError !== undefined && <span role="alert">{state.conversationModeError}</span>}
    </div>
  )
}
