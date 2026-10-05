/** Sidebar entry and dialog for the Gouzi roster: list, adopt, edit, wake, rest, and retire. */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import clsx from 'clsx'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import {
  GOUZI_AVATARS,
  GOUZI_AVATAR_NAMES,
  GOUZI_ROLE_COPY,
  GOUZI_ROLE_IDS,
  GOUZI_STATE_COPY,
  type GouziAvatar,
  GOUZI_LOCAL_HOST_ID,
  type GouziDashboardV1,
  type GouziHostProjection,
  type GouziMemberProjection,
  type GouziRoleId,
  type GouziProjectsCheck,
} from '../contracts.ts'
import { GouziAvatarImage } from './avatars.tsx'
import { checkGouziProjects, controlGouzi, loadGouzi, type BrowserRequest } from './api.ts'
import { HostStep, messageOf } from './HostStep.tsx'
import { RemoteFolderPicker } from './RemoteFolderPicker.tsx'
import css from './GouziPanel.module.css'

/** Roster refresh interval while the management page is open. */
const OPEN_POLL_MS = 3_000
/** Roster refresh interval while only the sidebar entry is visible. */
const IDLE_POLL_MS = 20_000

/** The slice of the workspace service the adoption wizard reads: known folders and the native picker. */
export type GouziFolders = Pick<IWorkspaces, 'list' | 'pickDirectory'>

/** Suggested projects shown in the wizard; the rest stay reachable through the folder picker. */
const SUGGESTION_LIMIT = 6

interface FolderChoice {
  path: string
  title: string
}

function basename(path: string): string {
  return path.split('/').filter(part => part.length > 0).at(-1) ?? path
}

/**
 * Poll the roster; `open` shortens the interval.
 * @param request - authenticated fetch.
 * @param open - whether a management page is showing, which polls faster.
 * @returns the latest dashboard, the latest load error, and a manual refresh.
 */
export function useRoster(request: BrowserRequest, open: boolean) {
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

const WIZARD_STEPS = ['头像', '名字', '住处', '角色与项目', '确认'] as const

/** Local projects are selectable only after the Host resolves their Git repository and origin. */
function ProjectPicker({ request, folders, picked, onPick, selected, onChange, onValidity }: {
  request: BrowserRequest
  folders: GouziFolders
  picked: readonly FolderChoice[]
  onPick: (path: string) => void
  selected: readonly string[]
  onChange: (paths: readonly string[]) => void
  onValidity: (valid: boolean) => void
}) {
  const { list: source } = folders
  const list = useSyncExternalStore(callback => source.subscribe(callback), () => source.getSnapshot())
  const [notice, setNotice] = useState<string>()
  const [picking, setPicking] = useState(false)
  const [checks, setChecks] = useState<GouziProjectsCheck['projects']>([])
  const suggestions = useMemo<readonly FolderChoice[]>(() => {
    const known = [...list.items]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, SUGGESTION_LIMIT)
      .map(item => ({ path: item.path, title: item.title }))
    return [...picked.filter(choice => !known.some(item => item.path === choice.path)), ...known]
  }, [list.items, picked])
  const preselected = useRef(false)
  const pickSequence = useRef(0)
  const desiredPick = useRef<string>()
  const current = useRef({ selected, onChange })
  current.current = { selected, onChange }
  useEffect(() => () => { pickSequence.current++ }, [])
  useEffect(() => {
    let active = true
    setChecks([])
    setNotice(undefined)
    onValidity(false)
    const paths = suggestions.map(choice => choice.path)
    if (paths.length === 0) return () => { active = false }
    void checkGouziProjects(request, paths)
      .then((reply) => {
        if (!active) return
        setChecks(reply.projects)
        const usable = new Set(reply.projects.filter(check => check.usable).map(check => check.path))
        const retained = current.current.selected.filter(path => usable.has(path))
        const desired = desiredPick.current
        desiredPick.current = undefined
        if (desired !== undefined && usable.has(desired)) {
          preselected.current = true
          current.current.onChange([...new Set([...retained, desired])])
        } else if (!preselected.current && retained.length === 0) {
          const recent = list.items.find(item => item.workspaceId === list.recentWorkspaceId)?.path
          const first = recent !== undefined && usable.has(recent) ? recent : paths.find(path => usable.has(path))
          if (first !== undefined) {
            preselected.current = true
            current.current.onChange([first])
          } else current.current.onChange(retained)
        } else current.current.onChange(retained)
      })
      .catch((cause: unknown) => { if (active) setNotice(messageOf(cause)) })
    return () => { active = false }
  }, [request, suggestions, list.items, list.recentWorkspaceId, onValidity])
  useEffect(() => {
    onValidity(!picking && selected.length > 0 && selected.every(path => checks.some(check => check.path === path && check.usable)))
  }, [checks, selected, picking, onValidity])
  const toggle = (path: string): void => {
    if (!checks.some(check => check.path === path && check.usable)) return
    preselected.current = true
    onChange(selected.includes(path) ? selected.filter(item => item !== path) : [...selected, path])
  }
  const choose = async (): Promise<void> => {
    const sequence = ++pickSequence.current
    setNotice(undefined)
    setPicking(true)
    onValidity(false)
    try {
      const path = await folders.pickDirectory()
      if (sequence !== pickSequence.current || path === null) return
      desiredPick.current = path
      onPick(path)
    } catch (cause) {
      if (sequence === pickSequence.current) setNotice(messageOf(cause))
    } finally {
      if (sequence === pickSequence.current) setPicking(false)
    }
  }
  return (
    <div className={css.field}>
      <span>它可以处理的项目（在运行 DSH 的这台机器上）</span>
      <p className={css.hint}>当前需要带有效 origin 的 Git 仓库，普通目录暂不支持。</p>
      {suggestions.length > 0
        ? (
          <ul className={css.projectList}>
            {suggestions.map((choice) => {
              const check = checks.find(value => value.path === choice.path)
              return (
                <li key={choice.path}>
                  <label className={clsx(css.projectChoice, selected.includes(choice.path) && check?.usable === true && css.chosen)}>
                    <input type="checkbox" disabled={check?.usable !== true || picking} checked={selected.includes(choice.path) && check?.usable === true} onChange={() => { toggle(choice.path) }} />
                    <strong>{choice.title}</strong>
                    <span title={choice.path}>{choice.path}</span>
                    <span>{check === undefined ? notice === undefined ? '正在检查项目…' : '项目检查失败' : check.usable ? '可用' : check.message}</span>
                  </label>
                </li>
              )
            })}
          </ul>
        )
        : <p className={css.hint}>还没有打开过项目，点下面的按钮选择一个文件夹。</p>}
      <button type="button" disabled={picking} className={css.secondary} onClick={() => { void choose() }}>选择文件夹…</button>
      {notice !== undefined && <p className={css.error} role="alert">{notice}</p>}
    </div>
  )
}

function AdoptWizard({ request, folders, hosts, onHostsChanged, used, limit, onDone, onCancel }: {
  request: BrowserRequest
  folders: GouziFolders
  hosts: readonly GouziHostProjection[]
  onHostsChanged: () => Promise<void>
  used: number
  limit: number
  onDone: () => void
  onCancel: () => void
}) {
  const [step, setStep] = useState(0)
  const [avatarId, setAvatarId] = useState<GouziAvatar>('shiba')
  const [name, setName] = useState('')
  const [role, setRole] = useState<GouziRoleId>('development')
  const [hostId, setHostId] = useState(GOUZI_LOCAL_HOST_ID)
  const [paths, setPaths] = useState<readonly string[]>([])
  const [picked, setPicked] = useState<readonly FolderChoice[]>([])
  const pickProject = useCallback((path: string) => {
    setPicked(currentChoices => [...currentChoices.filter(choice => choice.path !== path), { path, title: basename(path) }])
  }, [])
  const [projectsValid, setProjectsValid] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const trimmed = name.trim()
  const valid = [
    true, trimmed.length > 0 && trimmed.length <= 40, hosts.some(host => host.hostId === hostId),
    paths.length > 0 && (hostId !== GOUZI_LOCAL_HOST_ID || projectsValid), true,
  ]
  const hostLabel = hosts.find(host => host.hostId === hostId)?.label ?? ''
  const adopt = async (): Promise<void> => {
    setPending(true)
    setError(undefined)
    try {
      await controlGouzi(request, { action: 'adopt', name: trimmed, avatarId, role, hostId, projects: [...paths] })
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
        <HostStep
          request={request}
          hosts={hosts}
          value={hostId}
          onChange={(next) => { setHostId(next); setPaths([]); setPicked([]); setProjectsValid(false) }}
          onHostsChanged={onHostsChanged}
        />
      )}
      {step === 3 && (
        <>
          <RolePicker value={role} onChange={setRole} />
          {hostId === GOUZI_LOCAL_HOST_ID
            ? <ProjectPicker
              request={request} folders={folders} picked={picked} onPick={pickProject}
              selected={paths} onChange={setPaths} onValidity={setProjectsValid}
            />
            : <RemoteFolderPicker request={request} hostId={hostId} selected={paths} onChange={setPaths} />}
        </>
      )}
      {step === 4 && (
        <dl className={css.summary}>
          <div><GouziAvatarImage avatarId={avatarId} size={64} /></div>
          <div><dt>名字</dt><dd>{trimmed}</dd></div>
          <div><dt>住处</dt><dd>{hostLabel}</dd></div>
          <div><dt>角色</dt><dd>{GOUZI_ROLE_COPY[role].label}</dd></div>
          <div><dt>项目</dt><dd>{paths.map(basename).join('、')}</dd></div>
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
        <span>{GOUZI_ROLE_COPY[member.role].label} · 住在 {member.hostLabel}</span>
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

/**
 * Roster, adoption, and per-member controls for the Settings page.
 * @param props - authenticated fetch and the workspace slice the adoption wizard reads.
 * @returns the management surface.
 */
export function GouziManager({ request, folders }: { request: BrowserRequest; folders: GouziFolders }) {
  const { dashboard, error: loadError, refresh } = useRoster(request, true)
  const [mode, setMode] = useState<{ kind: 'list' } | { kind: 'adopt' } | { kind: 'edit'; member: GouziMemberProjection }>({ kind: 'list' })
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string>()
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
    <section className={css.manager} aria-label="狗子">
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
        </div>
      </header>
      <div className={css.body}>
        {(loadError ?? actionError) !== undefined && <p className={css.error} role="alert">{loadError ?? actionError}</p>}
        {dashboard?.hostAvailable === false && <p className={css.note}>这台机器还不能启动狗子，只能查看。</p>}
        {dashboard?.canManage === false && <p className={css.note}>这个设备只能查看狗子。</p>}
        {mode.kind === 'adopt' && dashboard !== undefined && (
          <AdoptWizard
            request={request}
            folders={folders}
            hosts={dashboard.hosts}
            onHostsChanged={async () => { await refresh() }}
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
  )
}

/** What the Settings page is given: the authenticated fetch and the workspace slice the wizard reads. */
export interface GouziSettingsInjected {
  readonly request: BrowserRequest
  readonly folders: GouziFolders
}

/**
 * The Settings section: the management surface under the page the registry supplies.
 * @param props - authenticated fetch and workspace slice.
 * @returns the management surface.
 */
export function GouziSettings({ request, folders }: GouziSettingsInjected) {
  return <GouziManager request={request} folders={folders} />
}
