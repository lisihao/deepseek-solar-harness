/** Sidebar entry of the kennel: the dogs' faces and how many are awake, opening the shared chat. */
import { useState } from 'react'
import clsx from 'clsx'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { GouziAvatarImage } from './avatars.tsx'
import type { BrowserRequest } from './api.ts'
import { messageOf } from './HostStep.tsx'
import { useRoster } from './GouziPanel.tsx'
import css from './Kennel.module.css'

/** Faces shown beside the label; the rest are counted. */
const FACE_LIMIT = 3

/** Slot runtime, the browser's authenticated fetch, and the action that opens the kennel session. */
export type KennelEntryProps = Pick<PropsRuntime<'sidebar.footer.action'>, 'wide'> & {
  request: BrowserRequest
  open: () => Promise<void>
}

/**
 * The sidebar row.
 * @param props - slot runtime, roster fetch, and the opener.
 * @returns a button; a failed open is shown under it.
 */
export function KennelEntry({ wide, request, open }: KennelEntryProps) {
  const { dashboard } = useRoster(request, false)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string>()
  const members = dashboard?.members ?? []
  const awake = members.filter(member => member.connection === 'online').length
  const click = async (): Promise<void> => {
    setOpening(true)
    setError(undefined)
    try {
      await open()
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
      {error !== undefined && <p className={css.error} role="alert">{error}</p>}
    </>
  )
}
