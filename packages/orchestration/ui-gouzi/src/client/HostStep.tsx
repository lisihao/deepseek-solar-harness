/** Wizard step "where it lives": the local machine, an SSH machine already added, or a new one. */
import { useState } from 'react'
import clsx from 'clsx'
import { GOUZI_LOCAL_HOST_ID, type GouziHostInspection, type GouziHostProjection } from '../contracts.ts'
import { callGouzi, type BrowserRequest } from './api.ts'
import css from './GouziPanel.module.css'

/** Explanation of a failed request, whatever it threw. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface AddForm {
  address: string
  port: string
  user: string
  password: string
  label: string
}

const EMPTY_FORM: AddForm = { address: '', port: '22', user: '', password: '', label: '' }

function formValid(form: AddForm): boolean {
  const port = Number(form.port)
  return form.address.trim().length > 0 && form.user.trim().length > 0 && form.password.length > 0
    && Number.isInteger(port) && port >= 1 && port <= 65_535
}

/**
 * Add another machine: read its key, let the user compare the fingerprint, then log in once with the password.
 * The password lives in this component's state only until the request ends; the Host never stores it.
 */
function AddHostForm({ request, onAdded, onCancel }: {
  request: BrowserRequest
  onAdded: (host: GouziHostProjection) => void
  onCancel: () => void
}) {
  const [form, setForm] = useState<AddForm>(EMPTY_FORM)
  const [inspection, setInspection] = useState<GouziHostInspection>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const set = (patch: Partial<AddForm>): void => { setForm(current => ({ ...current, ...patch })); setInspection(undefined) }
  const target = { address: form.address.trim(), port: Number(form.port), user: form.user.trim() }
  const inspect = async (): Promise<void> => {
    setPending(true)
    setError(undefined)
    try {
      setInspection(await callGouzi<GouziHostInspection>(request, { action: 'host-inspect', ...target }))
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setPending(false)
    }
  }
  const connect = async (): Promise<void> => {
    if (inspection === undefined) return
    setPending(true)
    setError(undefined)
    try {
      const label = form.label.trim()
      const host = await callGouzi<GouziHostProjection>(request, {
        action: 'host-add', ...target, password: form.password, fingerprint: inspection.fingerprint, ...label.length === 0 ? {} : { label },
      })
      setForm(EMPTY_FORM)
      onAdded(host)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setPending(false)
    }
  }
  return (
    <fieldset className={css.addHost} disabled={pending}>
      <legend>添加一台机器</legend>
      <label className={css.field}>
        <span>地址（IP 或主机名）</span>
        <input value={form.address} placeholder="192.168.1.20 或 mini.local" autoFocus onChange={(event) => { set({ address: event.target.value }) }} />
      </label>
      <div className={css.inline}>
        <label className={css.field}>
          <span>用户名</span>
          <input value={form.user} autoComplete="off" onChange={(event) => { set({ user: event.target.value }) }} />
        </label>
        <label className={clsx(css.field, css.narrow)}>
          <span>端口</span>
          <input value={form.port} inputMode="numeric" onChange={(event) => { set({ port: event.target.value }) }} />
        </label>
      </div>
      <label className={css.field}>
        <span>登录密码（只用这一次，不会保存）</span>
        <input type="password" value={form.password} autoComplete="off" onChange={(event) => { set({ password: event.target.value }) }} />
      </label>
      <label className={css.field}>
        <span>给它起个名字（可选）</span>
        <input value={form.label} maxLength={40} placeholder="比如：Mac mini" onChange={(event) => { setForm({ ...form, label: event.target.value }) }} />
      </label>
      {inspection !== undefined && (
        <p className={css.note} role="status">
          这台机器的指纹是 <code>{inspection.fingerprint}</code>（{inspection.keyType}）。
          请确认和那台机器自己显示的一致，再继续。
        </p>
      )}
      {error !== undefined && <p className={css.error} role="alert">{error}</p>}
      <div className={css.wizardActions}>
        <button type="button" className={css.secondary} onClick={onCancel}>取消</button>
        {inspection === undefined
          ? <button type="button" className={css.primary} disabled={!formValid(form)} onClick={() => { void inspect() }}>{pending ? '正在检查…' : '检查这台机器'}</button>
          : <button type="button" className={css.primary} onClick={() => { void connect() }}>{pending ? '正在连接…' : '指纹对，连接并安装'}</button>}
      </div>
    </fieldset>
  )
}

/** Choose where the new member lives. */
export function HostStep({ request, hosts, value, onChange, onHostsChanged }: {
  request: BrowserRequest
  hosts: readonly GouziHostProjection[]
  value: string
  onChange: (hostId: string) => void
  onHostsChanged: () => Promise<void>
}) {
  const [adding, setAdding] = useState(false)
  return (
    <div className={css.field}>
      <span>狗子住在哪台机器上</span>
      <div className={css.roleList} role="radiogroup" aria-label="狗子住在哪台机器上">
        {hosts.map(host => (
          <button
            key={host.hostId}
            type="button"
            role="radio"
            aria-checked={host.hostId === value}
            className={clsx(css.roleChoice, host.hostId === value && css.chosen)}
            onClick={() => { onChange(host.hostId) }}
          >
            <strong>{host.hostId === GOUZI_LOCAL_HOST_ID ? `${host.label}（本机）` : host.label}</strong>
            <span>{host.kind === 'local' ? '和 DSH 在同一台电脑上' : `${host.address ?? ''} · DSH Desktop ${host.appVersion ?? ''}`}</span>
          </button>
        ))}
      </div>
      {adding
        ? (
          <AddHostForm
            request={request}
            onCancel={() => { setAdding(false) }}
            onAdded={(host) => {
              setAdding(false)
              void onHostsChanged().then(() => { onChange(host.hostId) })
            }}
          />
        )
        : <button type="button" className={css.secondary} onClick={() => { setAdding(true) }}>添加另一台机器（SSH）…</button>}
    </div>
  )
}
