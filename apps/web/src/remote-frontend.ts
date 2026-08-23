/** Browser-only pairing bootstrap for phone and non-Electron Frontend clients. */

import {
  setBrowserRemoteAccessToken,
  WebRemoteAuthClient,
  type RemoteAccessSession,
  type RemoteDeviceCredential,
} from '@deepseek-ai/dsh-client-connection/browser-remote'

const ROLE_PARAM = 'dsh-deployment-role'
const DESKTOP_PARAM = 'dsh-desktop-platform'

/** Pair/exchange before the Cordis client tree makes its first remote request. */
export async function prepareRemoteFrontend(): Promise<void> {
  const url = new URL(globalThis.location.href)
  if (url.searchParams.get(ROLE_PARAM) !== 'frontend' || url.searchParams.has(DESKTOP_PARAM)) return

  const storageKey = `dsh.remote-device.v1:${url.origin}`
  const client = new WebRemoteAuthClient(url.origin)
  let credential = readCredential(storageKey)
  let session: RemoteAccessSession | undefined
  let problem: string | undefined
  while (session === undefined) {
    if (credential === undefined) {
      const input = await requestPairing(problem)
      try {
        credential = await client.redeemPairing(input.code, input.deviceName)
        localStorage.setItem(storageKey, JSON.stringify(credential))
        problem = undefined
      } catch (error) {
        problem = error instanceof Error ? error.message : String(error)
        continue
      }
    }
    try {
      session = await client.exchange(credential.credential)
    } catch (error) {
      localStorage.removeItem(storageKey)
      credential = undefined
      problem = error instanceof Error ? error.message : String(error)
    }
  }
  if (credential === undefined) throw new Error('web app: remote credential missing after access exchange')
  document.documentElement.dataset.dshRemoteScope = session.scope
  setBrowserRemoteAccessToken(session.accessToken)
  startRefresh(client, credential, session)
  document.getElementById('root')?.replaceChildren()
}

function readCredential(storageKey: string): RemoteDeviceCredential | undefined {
  const raw = localStorage.getItem(storageKey)
  if (raw === null) return undefined
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if (typeof value.deviceId !== 'string' || typeof value.credential !== 'string'
      || (value.scope !== 'cockpit' && value.scope !== 'pocket' && value.scope !== 'admin')) {
      throw new Error('invalid credential')
    }
    return { deviceId: value.deviceId, credential: value.credential, scope: value.scope }
  } catch {
    localStorage.removeItem(storageKey)
    return undefined
  }
}

function startRefresh(
  client: WebRemoteAuthClient,
  credential: RemoteDeviceCredential,
  initial: RemoteAccessSession,
): void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  function schedule(session: RemoteAccessSession): void {
    const delay = Math.max(1_000, Date.parse(session.expiresAt) - Date.now() - 60_000)
    timer = setTimeout(refresh, delay)
  }
  function refresh(): void {
    void client.exchange(credential.credential).then((next) => {
      if (stopped) return
      setBrowserRemoteAccessToken(next.accessToken)
      schedule(next)
    }).catch(() => {
      if (stopped) return
      timer = setTimeout(refresh, 30_000)
    })
  }
  const stop = (): void => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    setBrowserRemoteAccessToken(undefined)
  }
  globalThis.addEventListener('pagehide', stop, { once: true })
  schedule(initial)
}

function requestPairing(problem?: string): Promise<{ code: string; deviceName: string }> {
  const root = document.getElementById('root')
  if (root === null) return Promise.reject(new Error('web app: missing #root'))
  const shell = document.createElement('main')
  shell.className = 'dsh-pairing'
  const card = document.createElement('form')
  card.className = 'dsh-pairing__card'
  card.innerHTML = `
    <h1>连接 DSH Server</h1>
    <p>在 Server 端生成一次性配对码，然后在这里输入。设备凭据只保存在当前浏览器。</p>
    <label>设备名称<input name="deviceName" maxlength="100" required></label>
    <label>8 位配对码<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{8}" maxlength="8" required></label>
    <p class="dsh-pairing__error" role="alert"></p>
    <button type="submit">连接</button>
  `
  const style = document.createElement('style')
  style.textContent = `
    :root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    body{margin:0;background:#0b0f14;color:#edf3f8}
    .dsh-pairing{min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box}
    .dsh-pairing__card{width:min(420px,100%);display:grid;gap:18px;padding:28px;border:1px solid #293444;border-radius:18px;background:#151b24;box-shadow:0 18px 60px #0008}
    .dsh-pairing h1,.dsh-pairing p{margin:0}.dsh-pairing p{color:#aeb9c6;line-height:1.55}
    .dsh-pairing label{display:grid;gap:8px;font-size:14px}.dsh-pairing input{font:inherit;color:inherit;background:#0d1219;border:1px solid #364355;border-radius:10px;padding:12px}
    .dsh-pairing button{font:inherit;font-weight:700;color:#07101a;background:#6ad7ff;border:0;border-radius:10px;padding:12px;cursor:pointer}
    .dsh-pairing__error{min-height:1.4em;color:#ff9b9b!important}
  `
  shell.append(card)
  root.replaceChildren(style, shell)
  const device = card.elements.namedItem('deviceName') as HTMLInputElement
  const code = card.elements.namedItem('code') as HTMLInputElement
  device.value = navigator.platform || 'Phone'
  code.focus()
  const error = card.querySelector<HTMLElement>('.dsh-pairing__error')
  if (error !== null) error.textContent = problem ?? ''
  return new Promise((resolve) => {
    card.addEventListener('submit', (event) => {
      event.preventDefault()
      resolve({ code: code.value, deviceName: device.value })
    }, { once: true })
  })
}
