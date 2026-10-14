import { useState } from 'react'
import type {
  DesktopResidentRecoveryAction,
  DesktopResidentRecoveryFailure,
  DesktopResidentSession,
} from '../contracts.ts'
import { RESIDENT_SESSION_RECOVERY_PATH } from '../contracts.ts'
import { formatResidentTimestamp } from '../presentation.ts'
import type { BrowserRequest } from './ResidentOperatorsPanel.tsx'

/**
 * Ask the Host to release one closed lane. The Host decides from its own reading of the lane; this only carries the
 * owner's choice and the revision the owner looked at.
 * @param session - the lane the owner looked at.
 * @param action - keep the native session (`resolve`) or start a new one (`reset`).
 * @param request - authenticated same-origin browser request.
 * @returns nothing; a refusal throws with the Host's readable message.
 */
export async function recoverResidentSession(
  session: Pick<DesktopResidentSession, 'sessionId' | 'stateRevision'>,
  action: DesktopResidentRecoveryAction,
  request: BrowserRequest = globalThis.fetch,
): Promise<void> {
  const url = new URL(RESIDENT_SESSION_RECOVERY_PATH, window.location.origin)
  url.searchParams.set('session_id', session.sessionId)
  url.searchParams.set('action', action)
  url.searchParams.set('revision', String(session.stateRevision))
  const response = await request(url, { method: 'POST', cache: 'no-store' })
  if (response.ok) return
  let failure: Partial<DesktopResidentRecoveryFailure> = {}
  try {
    failure = await response.json() as Partial<DesktopResidentRecoveryFailure>
  } catch {
    // A body that is not JSON leaves the generic message below.
  }
  throw new Error(failure.message ?? '没有成功处理这条 lane，请刷新后重试。')
}

const CONSEQUENCE: Readonly<Record<DesktopResidentRecoveryAction, string>> = {
  resolve: '这条 lane 会继续使用原来的 Codex 对话。如果那条任务其实还在运行，下一条任务可能与它互相冲突。',
  reset: '下一条任务会开启新的 Codex 对话并重新选择模型，原来的对话内容不会再被接续。',
}

/**
 * Explain why a lane takes no new task and let the local owner release it. Both choices are the owner's decision:
 * neither one stops anything running in the native product, and neither one undoes files that task already changed.
 */
export function ClosedLaneNotice(props: {
  session: DesktopResidentSession
  localOwner: boolean
  generatedAt: string
  timeZone: string
  request: BrowserRequest
  onChanged: () => void
}) {
  const [choice, setChoice] = useState<DesktopResidentRecoveryAction>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string>()
  const turn = props.session.latestTurn
  const started = turn === undefined ? undefined : formatResidentTimestamp(turn.updatedAt, props.generatedAt, props.timeZone)

  const confirm = async (): Promise<void> => {
    if (choice === undefined) return
    setBusy(true)
    setMessage(undefined)
    try {
      await recoverResidentSession(props.session, choice, props.request)
      setChoice(undefined)
      props.onChanged()
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause))
      props.onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dshDesktopResidentRecovery" role="group" aria-label="已暂停的执行 lane">
      <strong>这条 lane 已暂停接收新任务</strong>
      <p>
        上一条任务「{turn?.taskLabel ?? '历史任务'}」{started === undefined ? '' : `（${started.absolute}）`}
        在 Codex 里是否已经结束，DSH 无法确认。为避免同一件事被做两遍，新任务会被拒绝。
      </p>
      <p>下面的处理不会停止 Codex 里可能还在运行的任务，也不会撤销它已经改动的文件。</p>
      {!props.localOwner && <p>请在运行 DSH 的这台电脑上处理。</p>}
      {props.localOwner && choice === undefined && (
        <div className="dshDesktopResidentRecoveryActions">
          <button type="button" onClick={() => { setChoice('resolve') }}>我已确认它结束了，恢复这条 lane</button>
          <button type="button" onClick={() => { setChoice('reset') }}>重置这条 lane</button>
        </div>
      )}
      {props.localOwner && choice !== undefined && (
        <div className="dshDesktopResidentRecoveryConfirm">
          <p>{CONSEQUENCE[choice]}</p>
          <div className="dshDesktopResidentRecoveryActions">
            <button type="button" disabled={busy} onClick={() => { void confirm() }}>
              {busy ? '正在处理…' : choice === 'resolve' ? '确认恢复' : '确认重置'}
            </button>
            <button type="button" disabled={busy} onClick={() => { setChoice(undefined) }}>取消</button>
          </div>
        </div>
      )}
      {message !== undefined && <p role="alert" className="dshDesktopResidentRecoveryError">{message}</p>}
    </div>
  )
}
