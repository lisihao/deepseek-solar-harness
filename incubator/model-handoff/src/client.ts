/** Browser affordance only; the Host handoff gate remains authoritative. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { createElement, useLayoutEffect, useState } from 'react'
import { PreparationObserver, type PreparationState } from './progress.js'

export const inject = ['sessions', 'conversation', 'slots']
export function apply(ctx: Context): void {
  function PreparationNotice({ sessionId }: PropsRuntime<'conversation.input.dock'>) {
    const binding = ctx.sessions.binding(sessionId)
    const [state, setState] = useState<PreparationState | undefined>()
    useLayoutEffect(() => {
      if (!binding) { setState(undefined); return }
      const observer = new PreparationObserver(sessionId, binding.eventSource, ctx.conversation.blocks)
      const update = () => setState(observer.getSnapshot())
      const unsubscribe = observer.subscribe(update)
      update()
      return () => { unsubscribe(); observer.dispose() }
    }, [binding, sessionId])
    if (!state) return null
    return createElement('div', {
      role: 'status', 'aria-live': 'polite', 'aria-busy': state.busy,
      style: { boxSizing: 'border-box', width: '100%', maxWidth: 'var(--dsh-composer-card-max-width)',
        padding: '12px 16px', borderRadius: '12px', lineHeight: 1.6, overflowWrap: 'anywhere',
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-specific-input-major)',
        border: '1px solid var(--dsw-alias-border-l2)' },
    }, createElement('strong', null, state.busy ? '正在准备上下文…' : state.fresh ? '已使用空白上下文' : '模型交接未完成'),
    createElement('div', null, state.busy
      ? '正在准备任务上下文。可选择携带任务内容，或取消交接并空白开始。输入和发送暂时停用，原草稿会保留。'
      : state.message))
  }
  ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'solar-model-handoff-preparation',
  }, PreparationNotice)))
}
