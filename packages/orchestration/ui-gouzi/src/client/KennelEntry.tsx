/** Sidebar entry of the kennel: the dogs' faces and how many are awake, opening the shared chat. */
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { GouziAvatarImage } from './avatars.tsx'
import type { BrowserRequest } from './api.ts'
import { messageOf } from './HostStep.tsx'
import { useRoster } from './GouziPanel.tsx'
import { KENNEL_OPEN_TIMEOUT_MS, type OpenKennelResult } from './kennel.ts'
import css from './Kennel.module.css'

/** Faces shown beside the label; the rest are counted. */
const FACE_LIMIT = 3

/** Slot runtime, the browser's authenticated fetch, and the action that opens the kennel session. */
export type KennelEntryProps = Pick<PropsRuntime<'sidebar.footer.action'>, 'wide'> & {
  request: BrowserRequest
  open: () => Promise<OpenKennelResult>
  /** Longest wait for `open`, in milliseconds. */
  timeoutMs?: number
}

/** How long the "already here" note stays, in milliseconds. */
const NOTE_MS = 5_000

/** Reject when `pending` has not settled within `ms`, so a hung open cannot leave the button dead. */
function withinTime<T>(pending: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolveWithin, rejectWithin) => {
    const timer = setTimeout(() => { rejectWithin(new Error('打开狗窝超时了，请再点一次；如果一直这样，请重启 DSH。')) }, ms)
    pending.then(
      (value) => { clearTimeout(timer); resolveWithin(value) },
      (cause: unknown) => { clearTimeout(timer); rejectWithin(cause instanceof Error ? cause : new Error(String(cause))) },
    )
  })
}

/**
 * The sidebar row.
 * @param props - slot runtime, roster fetch, and the opener.
 * @returns a button; a failed open is shown under it.
 */
export function KennelEntry({ wide, request, open, timeoutMs = KENNEL_OPEN_TIMEOUT_MS }: KennelEntryProps) {
  const { dashboard } = useRoster(request, false)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string>()
  const [note, setNote] = useState<string>()
  const noteTimer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => { clearTimeout(noteTimer.current) }, [])
  const members = dashboard?.members ?? []
  const awake = members.filter(member => member.connection === 'online').length
  const click = async (): Promise<void> => {
    setOpening(true)
    setError(undefined)
    setNote(undefined)
    clearTimeout(noteTimer.current)
    try {
      const result = await withinTime(open(), timeoutMs)
      if (result.kind === 'already') {
        setNote('你已经在狗窝里了。换话题请用房间右侧的“话题”。')
        noteTimer.current = setTimeout(() => { setNote(undefined) }, NOTE_MS)
      }
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setOpening(false)
    }
  }
  const label = '狗窝'
  const size = wide ? 20 : 24
  // With no dogs yet the row still shows one friendly face, so the entry is findable before the first adoption.
  const faces = members.length === 0
    ? [{ key: 'empty', avatarId: 'shiba' as const }]
    : members.slice(0, FACE_LIMIT).map(member => ({ key: member.gouziId, avatarId: member.avatarId }))
  const tip = members.length === 0 ? `${label}：还没有狗子，先到 设置 → 狗子 领养` : `${label}：${String(awake)} / ${String(members.length)} 只在线`
  return (
    <>
      <Tooltip label={tip} delayMs={500} disabled={wide}>
        <button type="button" className={clsx(css.trigger, !wide && css.rail)} aria-label={label} disabled={opening} onClick={() => { void click() }}>
          <span className={css.stack}>
            {faces.map(face => <GouziAvatarImage key={face.key} avatarId={face.avatarId} size={size} />)}
          </span>
          {wide && <span className={css.label}>{label}</span>}
          {wide && members.length > 0 && <span className={css.badge}>{awake}/{members.length}</span>}
        </button>
      </Tooltip>
      {note !== undefined && <p className={css.note} role="status">{note}</p>}
      {error !== undefined && <p className={css.error} role="alert">{error}</p>}
    </>
  )
}
