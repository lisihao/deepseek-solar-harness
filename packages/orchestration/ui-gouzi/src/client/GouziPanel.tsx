/** Sidebar entry and dialog for the Gouzi roster: list, adopt, edit, wake, rest, and retire. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import {
  GOUZI_AVATARS,
  GOUZI_AVATAR_NAMES,
  GOUZI_ROLE_COPY,
  GOUZI_ROLE_IDS,
  GOUZI_STATE_COPY,
  type GouziAvatar,
  type GouziDashboardV1,
  type GouziMemberProjection,
  type GouziRoleId,
} from '../contracts.ts'
import { GouziAvatarImage } from './avatars.tsx'
import { controlGouzi, loadGouzi, type BrowserRequest } from './api.ts'
import css from './GouziPanel.module.css'

/** Roster refresh interval while the dialog is open. */
const OPEN_POLL_MS = 3_000
/** Roster refresh interval while only the sidebar badge is visible. */
const IDLE_POLL_MS = 20_000

/** Slot runtime plus the browser's authenticated fetch. */
export type GouziEntryProps = Pick<PropsRuntime<'sidebar.footer.action'>, 'wide'> & { request: BrowserRequest }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Poll the roster; `open` shortens the interval. */
function useRoster(request: BrowserRequest, open: boolean) {
  const [dashboard, setDashboard] = useState<GouziDashboardV1>()
  const [error, setError] = useState<string>()
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      setDashboard(await loadGouzi(request, signal))
      setError(undefined)
    } catch (cause) {
      if (signal?.aborted !== true) setError(messageOf(cause))
    }
  }, [request])
  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    const timer = setInterval(() => { void refresh(controller.signal) }, open ? OPEN_POLL_MS : IDLE_POLL_MS)
    return () => { controller.abort(); clearInterval(timer) }
  }, [open, refresh])
  return { dashboard, error, refresh }
}

function AvatarPicker({ value, onChange }: { value: GouziAvatar; onChange: (next: GouziAvatar) => void }) {
  return (
    <div className={css.avatarGrid} role="radiogroup" aria-label="选择头像">
      {GOUZI_AVATARS.map(id => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={value === id}
          className={clsx(css.avatarChoice, value === id && css.chosen)}
          onClick={() => { onChange(id) }}
        >
          <GouziAvatarImage avatarId={id} size={64} />
          <span>{GOUZI_AVATAR_NAMES[id]}</span>
        </button>
      ))}
    </div>
  )
}

function RolePicker({ value, onChange }: { value: GouziRoleId; onChange: (next: GouziRoleId) => void }) {
  return (
    <div className={css.roleList} role="radiogroup" aria-label="选择角色">
      {GOUZI_ROLE_IDS.map(id => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={value === id}
          className={clsx(css.roleChoice, value === id && css.chosen)}
          onClick={() => { onChange(id) }}
        >
          <strong>{GOUZI_ROLE_COPY[id].label}</strong>
          <span>{GOUZI_ROLE_COPY[id].goal}</span>
        </button>
      ))}
    </div>
  )
}

const WIZARD_STEPS = ['头像', '名字', '角色与项目', '确认'] as const

function AdoptWizard({ request, used, limit, onDone, onCancel }: {
  request: BrowserRequest
  used: number
  limit: number
  onDone: () => void
  onCancel: () => void
}) {
  const [step, setStep] = useState(0)
  const [avatarId, setAvatarId] = useState<GouziAvatar>('shiba')
  const [name, setName] = useState('')
  const [role, setRole] = useState<GouziRoleId>('development')
  const [projects, setProjects] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const paths = useMemo(() => projects.split('\n').map(line => line.trim()).filter(line => line.length > 0), [projects])
  const trimmed = name.trim()
  const valid = [true, trimmed.length > 0 && trimmed.length <= 40, paths.length > 0 && paths.every(path => path.startsWith('/')), true]
  const adopt = async (): Promise<void> => {
    setPending(true)
    setError(undefined)
    try {
      await controlGouzi(request, { action: 'adopt', name: trimmed, avatarId, role, projects: paths })
      onDone()
    } catch (cause) {
      setError(messageOf(cause))
      setPending(false)
    }
  }
  return (
    <section className={css.wizard} aria-label="领养一只狗子">
      <ol className={css.steps}>
        {WIZARD_STEPS.map((label, index) => (
          <li key={label} className={clsx(index === step && css.currentStep, index < step && css.doneStep)}>{label}</li>
        ))}
      </ol>
      {step === 0 && <AvatarPicker value={avatarId} onChange={setAvatarId} />}
      {step === 1 && (
        <label className={css.field}>
          <span>给它起个名字</span>
          <input
            value={name}
            maxLength={40}
            placeholder={`比如：小${GOUZI_AVATAR_NAMES[avatarId].slice(0, 1)}`}
            onChange={(event) => { setName(event.target.value) }}
            autoFocus
          />
        </label>
      )}
      {step === 2 && (
        <>
          <RolePicker value={role} onChange={setRole} />
          <label className={css.field}>
            <span>它可以处理的项目（每行一个绝对路径）</span>
            <textarea
              value={projects}
              rows={3}
              placeholder="/Users/你/Projects/某个仓库"
              onChange={(event) => { setProjects(event.target.value) }}
            />
          </label>
        </>
      )}
      {step === 3 && (
        <dl className={css.summary}>
          <div><GouziAvatarImage avatarId={avatarId} size={64} /></div>
          <div><dt>名字</dt><dd>{trimmed}</dd></div>
          <div><dt>角色</dt><dd>{GOUZI_ROLE_COPY[role].label}</dd></div>
          <div><dt>项目</dt><dd>{paths.join('、')}</dd></div>
          <div><dt>名额</dt><dd>领养后 {used + 1} / {limit}</dd></div>
        </dl>
      )}
      {error !== undefined && <p className={css.error} role="alert">{error}</p>}
      <footer className={css.wizardActions}>
        <button type="button" className={css.secondary} onClick={step === 0 ? onCancel : () => { setStep(step - 1) }} disabled={pending}>
          {step === 0 ? '取消' : '上一步'}
        </button>
        {step < WIZARD_STEPS.length - 1
          ? <button type="button" className={css.primary} disabled={!valid[step]} onClick={() => { setStep(step + 1) }}>下一步</button>
          : <button type="button" className={css.primary} disabled={pending} onClick={() => { void adopt() }}>{pending ? '正在领养…' : '领养'}</button>}
      </footer>
    </section>
  )
}

function EditForm({ member, request, onDone, onCancel }: {
  member: GouziMemberProjection
  request: BrowserRequest
  onDone: () => void
  onCancel: () => void
}) {
  const [name, setName] = useState(member.name)
  const [avatarId, setAvatarId] = useState<GouziAvatar>(member.avatarId)
  const [role, setRole] = useState<GouziRoleId>(member.role)
  const [error, setError] = useState<string>()
  const save = async (): Promise<void> => {
    try {
      await controlGouzi(request, { action: 'edit', gouziId: member.gouziId, name: name.trim(), avatarId, role })
      onDone()
    } catch (cause) {
      setError(messageOf(cause))
    }
  }
  return (
    <section className={css.wizard} aria-label={`修改 ${member.name}`}>
      <AvatarPicker value={avatarId} onChange={setAvatarId} />
      <label className={css.field}>
        <span>名字</span>
        <input value={name} maxLength={40} onChange={(event) => { setName(event.target.value) }} />
      </label>
      <RolePicker value={role} onChange={setRole} />
      {error !== undefined && <p className={css.error} role="alert">{error}</p>}
      <footer className={css.wizardActions}>
        <button type="button" className={css.secondary} onClick={onCancel}>取消</button>
        <button type="button" className={css.primary} disabled={name.trim().length === 0} onClick={() => { void save() }}>保存</button>
      </footer>
    </section>
  )
}

function MemberCard({ member, canManage, busy, onAction, onEdit }: {
  member: GouziMemberProjection
  canManage: boolean
  busy: boolean
  onAction: (action: 'wake' | 'rest' | 'retire', member: GouziMemberProjection) => void
  onEdit: (member: GouziMemberProjection) => void
}) {
  const working = member.state === 'working'
  const canWake = member.state === 'unreachable' || member.state === 'provisioning'
  const canRest = member.state === 'resting' || member.state === 'queued'
  return (
    <li className={css.card} data-state={member.state}>
      <GouziAvatarImage avatarId={member.avatarId} size={56} />
      <div className={css.identity}>
        <strong>{member.name}</strong>
        <span>{GOUZI_ROLE_COPY[member.role].label}</span>
      </div>
      <span className={css.status} data-state={member.state}>{GOUZI_STATE_COPY[member.state]}</span>
      {canManage && (
        <div className={css.cardActions}>
          <button type="button" className={css.link} disabled={busy} onClick={() => { onEdit(member) }}>修改</button>
          {canWake && <button type="button" className={css.link} disabled={busy} onClick={() => { onAction('wake', member) }}>唤醒</button>}
          {canRest && <button type="button" className={css.link} disabled={busy} onClick={() => { onAction('rest', member) }}>休息</button>}
          <button type="button" className={clsx(css.link, css.danger)} disabled={busy || working} onClick={() => { onAction('retire', member) }}>退役</button>
        </div>
      )}
    </li>
  )
}

function GouziDialog({ request, onClose }: { request: BrowserRequest; onClose: () => void }) {
  const { dashboard, error: loadError, refresh } = useRoster(request, true)
  const [mode, setMode] = useState<{ kind: 'list' } | { kind: 'adopt' } | { kind: 'edit'; member: GouziMemberProjection }>({ kind: 'list' })
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string>()
  const closeButton = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    closeButton.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [onClose])
  const act = async (action: 'wake' | 'rest' | 'retire', member: GouziMemberProjection): Promise<void> => {
    if (action === 'retire' && !window.confirm(`让 ${member.name} 退役？它会停下并交出名额，不能再回来。`)) return
    setBusy(true)
    setActionError(undefined)
    try {
      await controlGouzi(request, { action, gouziId: member.gouziId })
      await refresh()
    } catch (cause) {
      setActionError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }
  const full = dashboard !== undefined && dashboard.used >= dashboard.limit
  return (
    <div className={css.overlay} role="presentation">
      <div className={css.mask} aria-hidden="true" onClick={onClose} />
      <section className={css.panel} role="dialog" aria-modal="true" aria-label="狗子">
        <header className={css.header}>
          <div className={css.titles}>
            <strong>狗子</strong>
            <span>{dashboard === undefined ? '正在读取…' : `${dashboard.used} / ${dashboard.limit} 个名额`}</span>
          </div>
          <div className={css.headerActions}>
            {dashboard?.canManage === true && mode.kind === 'list' && (
              <Tooltip label={full ? '名额已满，先让一只狗子退役' : '领养一只新狗子'} disabled={false}>
                <button
                  type="button"
                  className={css.primary}
                  disabled={full || !dashboard.hostAvailable}
                  onClick={() => { setMode({ kind: 'adopt' }) }}
                >
                  领养狗子
                </button>
              </Tooltip>
            )}
            <button ref={closeButton} type="button" className={css.secondary} aria-label="关闭" onClick={onClose}>关闭</button>
          </div>
        </header>
        <div className={css.body}>
          {(loadError ?? actionError) !== undefined && <p className={css.error} role="alert">{loadError ?? actionError}</p>}
          {dashboard?.hostAvailable === false && <p className={css.note}>这台机器还不能启动狗子，只能查看。</p>}
          {dashboard?.canManage === false && <p className={css.note}>这个设备只能查看狗子。</p>}
          {mode.kind === 'adopt' && dashboard !== undefined && (
            <AdoptWizard
              request={request}
              used={dashboard.used}
              limit={dashboard.limit}
              onCancel={() => { setMode({ kind: 'list' }) }}
              onDone={() => { setMode({ kind: 'list' }); void refresh() }}
            />
          )}
          {mode.kind === 'edit' && (
            <EditForm
              member={mode.member}
              request={request}
              onCancel={() => { setMode({ kind: 'list' }) }}
              onDone={() => { setMode({ kind: 'list' }); void refresh() }}
            />
          )}
          {mode.kind === 'list' && dashboard !== undefined && (
            dashboard.members.length === 0
              ? <p className={css.empty}>还没有狗子。领养一只，让它在后台替你持续干活。</p>
              : (
                <ul className={css.list}>
                  {dashboard.members.map(member => (
                    <MemberCard
                      key={member.gouziId}
                      member={member}
                      canManage={dashboard.canManage}
                      busy={busy}
                      onAction={(action, target) => { void act(action, target) }}
                      onEdit={(target) => { setMode({ kind: 'edit', member: target }) }}
                    />
                  ))}
                </ul>
              )
          )}
        </div>
      </section>
    </div>
  )
}

/** The sidebar entry: a button with the current count, opening the roster dialog. */
export function GouziEntry({ wide, request }: GouziEntryProps) {
  const [open, setOpen] = useState(false)
  const { dashboard } = useRoster(request, open)
  const close = useCallback(() => { setOpen(false) }, [])
  const label = '狗子'
  const badge = dashboard === undefined ? undefined : `${dashboard.used}/${dashboard.limit}`
  return (
    <>
      <Tooltip label={label} delayMs={500} disabled={wide}>
        <button
          type="button"
          className={clsx(css.trigger, !wide && css.rail)}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={label}
          onClick={() => { setOpen(true) }}
        >
          <GouziAvatarImage avatarId="shiba" size={wide ? 20 : 24} />
          {wide && <span className={css.triggerLabel}>{label}</span>}
          {wide && badge !== undefined && <span className={css.badge}>{badge}</span>}
        </button>
      </Tooltip>
      {open && <GouziDialog request={request} onClose={close} />}
    </>
  )
}
