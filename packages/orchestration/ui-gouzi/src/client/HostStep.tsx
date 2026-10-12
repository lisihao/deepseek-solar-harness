/** Wizard step "where it lives": the local machine, an SSH machine already added, or a new one. */
import { useState } from 'react'
import clsx from 'clsx'
import { GOUZI_LOCAL_HOST_ID, type GouziHostInspection, type GouziHostProjection, type GouziSshRoute } from '../contracts.ts'
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
  tailscale: boolean
  socket: string
}

const EMPTY_FORM: AddForm = { address: '', port: '22', user: '', password: '', label: '', tailscale: false, socket: '' }

/** The route a form asks for: none for a direct connection, otherwise Tailscale with the optional socket. */
function routeOf(form: { tailscale: boolean; socket: string }): { route?: GouziSshRoute } {
  if (!form.tailscale) return {}
  const socket = form.socket.trim()
  return { route: { via: 'tailscale', ...socket.length === 0 ? {} : { socket } } }
}

/** Whether to reach the machine through Tailscale, and which tailscaled socket to use. */
function RouteFields({ tailscale, socket, onChange }: {
  tailscale: boolean
  socket: string
  onChange: (patch: { tailscale?: boolean; socket?: string }) => void
}) {
  return (
    <>
      <label className={css.field}>
        <span>
          <input type="checkbox" checked={tailscale} onChange={(event) => { onChange({ tailscale: event.target.checked }) }} />
          {' '}通过 Tailscale 连接（不在同一个局域网时用，地址填它的 Tailscale 名字或 100.x 地址）
        </span>
      </label>
      {tailscale && (
        <label className={css.field}>
          <span>Tailscale 的 socket 路径（可选，留空用默认）</span>
          <input value={socket} placeholder="/Users/你/.local/share/tailscale-userspace/tailscaled.sock" onChange={(event) => { onChange({ socket: event.target.value }) }} />
        </label>
      )}
    </>
  )
}

/** The user, address, and port of a stored host, from the `user@address:port` text its projection carries. */
function splitAddress(text: string | undefined): { address: string; port: string } {
  const found = /^[^@]*@(.+):(\d+)$/u.exec(text ?? '')
  return { address: found?.[1] ?? '', port: found?.[2] ?? '22' }
}

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
  const target = { address: form.address.trim(), port: Number(form.port), user: form.user.trim(), ...routeOf(form) }
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
      <RouteFields tailscale={form.tailscale} socket={form.socket} onChange={set} />
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

/**
 * Change how an existing machine is reached, for example from its home-network address to Tailscale. The machine
 * must present the key already pinned for it, so this cannot move its members onto another machine.
 */
function RerouteHostForm({ request, host, onDone, onCancel }: {
  request: BrowserRequest
  host: GouziHostProjection
  onDone: () => void
  onCancel: () => void
}) {
  const current = splitAddress(host.address)
  const [form, setForm] = useState({ address: current.address, port: current.port, tailscale: host.route !== undefined, socket: host.route?.socket ?? '' })
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const port = Number(form.port)
  const valid = form.address.trim().length > 0 && Number.isInteger(port) && port >= 1 && port <= 65_535
  const apply = async (): Promise<void> => {
    setPending(true)
    setError(undefined)
    try {
      await callGouzi<GouziHostProjection>(request, { action: 'host-route', hostId: host.hostId, address: form.address.trim(), port, ...routeOf(form) })
      onDone()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setPending(false)
    }
  }
  return (
    <fieldset className={css.addHost} disabled={pending}>
      <legend>修改 {host.label} 的连接方式</legend>
      <div className={css.inline}>
        <label className={css.field}>
          <span>地址（IP 或主机名）</span>
          <input value={form.address} onChange={(event) => { setForm({ ...form, address: event.target.value }) }} />
        </label>
        <label className={clsx(css.field, css.narrow)}>
          <span>端口</span>
          <input value={form.port} inputMode="numeric" onChange={(event) => { setForm({ ...form, port: event.target.value }) }} />
        </label>
      </div>
      <RouteFields tailscale={form.tailscale} socket={form.socket} onChange={(patch) => { setForm({ ...form, ...patch }) }} />
      <p className={css.note}>改完会检查那台机器的指纹和原来登记的一致，并用新的连接方式试一次；不一致或连不上就保持原样。</p>
      {error !== undefined && <p className={css.error} role="alert">{error}</p>}
      <div className={css.wizardActions}>
        <button type="button" className={css.secondary} onClick={onCancel}>取消</button>
        <button type="button" className={css.primary} disabled={!valid} onClick={() => { void apply() }}>{pending ? '正在检查…' : '检查并切换'}</button>
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
  const [rerouting, setRerouting] = useState<string>()
  const rerouted = hosts.find(host => host.hostId === rerouting)
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
            <span>{host.kind === 'local' ? '和 DSH 在同一台电脑上' : `${host.address ?? ''}${host.route === undefined ? '' : ' · 经 Tailscale'} · DSH Desktop ${host.appVersion ?? ''}`}</span>
          </button>
        ))}
      </div>
      {rerouted !== undefined
        ? (
          <RerouteHostForm
            key={rerouted.hostId}
            request={request}
            host={rerouted}
            onCancel={() => { setRerouting(undefined) }}
            onDone={() => { setRerouting(undefined); void onHostsChanged() }}
          />
        )
        : hosts.filter(host => host.kind === 'ssh').map(host => (
          <button key={host.hostId} type="button" className={css.secondary} onClick={() => { setRerouting(host.hostId) }}>修改 {host.label} 的连接方式…</button>
        ))}
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
