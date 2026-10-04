/** The kennel's welcome on the new-session screen: who is in it and how to talk to them. */
import { useSyncExternalStore } from 'react'
import type { ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { GOUZI_STATE_COPY, GOUZI_ROLE_COPY } from '../contracts.ts'
import { GouziAvatarImage } from './avatars.tsx'
import type { BrowserRequest } from './api.ts'
import { useRoster } from './GouziPanel.tsx'
import { KENNEL_PRESET } from './kennel.ts'
import css from './Kennel.module.css'

/** What the hero card is given. */
export interface KennelHeroProps {
  readonly request: BrowserRequest
  readonly sessions: Pick<ISessions, 'list'>
}

/**
 * The card under the workspace row of a blank session composed from the kennel preset. It renders nothing for any
 * other session, so the new-session screen of every other preset stays as it was.
 * @param props - roster fetch and the session list.
 * @returns the card, or nothing.
 */
export function KennelHero({ request, sessions }: KennelHeroProps) {
  const { list } = sessions
  const state = useSyncExternalStore(callback => list.subscribe(callback), () => list.getSnapshot())
  const { dashboard } = useRoster(request, false)
  const current = state.current === undefined ? undefined : state.byId[state.current]
  if (current?.agentPreset !== KENNEL_PRESET || !current.blank) return null
  const dogs = (dashboard?.members ?? []).filter(member => member.membership === 'enabled')
  return (
    <section className={css.hero} aria-label="狗窝">
      <strong>狗窝</strong>
      <span className={css.heroNote}>这个会话用的是「狗窝」预设，上面的预设标签可能还没刷新</span>
      <p>
        {dogs.length === 0
          ? '还没有狗子。到 设置 → 狗子 领养一只，再回到这里。'
          : '你的狗子们都在这儿。直接说要做什么，总管会把活分给它们并行去做；想点名就写 @名字。'}
      </p>
      {dogs.length > 0 && (
        <ul className={css.dogs}>
          {dogs.map(dog => (
            <li key={dog.gouziId}>
              <GouziAvatarImage avatarId={dog.avatarId} size={28} />
              <span className={css.dogName}>{dog.name}</span>
              <span className={css.dogMeta}>{GOUZI_ROLE_COPY[dog.role].label} · 住在 {dog.hostLabel} · {GOUZI_STATE_COPY[dog.state]}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
