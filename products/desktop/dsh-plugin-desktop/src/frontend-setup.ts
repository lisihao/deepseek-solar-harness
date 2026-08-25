/** Native pairing window for selecting a remote DSH Server before Host startup. */

import { BrowserWindow, ipcMain } from 'electron'
import { fileURLToPath } from 'node:url'
import {
  type ConfigureFrontendRequest,
  type DesktopDeploymentState,
  DesktopDeploymentStateStore,
} from './deployment-state.ts'

const DESCRIBE_CHANNEL = 'dsh-desktop:frontend-setup:describe'
const CONFIGURE_CHANNEL = 'dsh-desktop:frontend-setup:configure'
const USE_SERVER_CHANNEL = 'dsh-desktop:frontend-setup:use-server'
const CLOSE_CHANNEL = 'dsh-desktop:frontend-setup:close'

export class FrontendSetupController {
  private window: BrowserWindow | undefined

  constructor(
    private readonly store: DesktopDeploymentStateStore,
    private readonly readState: () => DesktopDeploymentState,
    private readonly restart: () => Promise<void>,
  ) {
    ipcMain.handle(DESCRIBE_CHANNEL, event => {
      this.assertSender(event.sender.id)
      const state = this.readState()
      return {
        role: state.role,
        endpoint: state.role === 'frontend' ? state.endpoint : '',
        deviceName: state.role === 'frontend' ? state.deviceName : '',
      }
    })
    ipcMain.handle(CONFIGURE_CHANNEL, async (event, value: unknown) => {
      this.assertSender(event.sender.id)
      await this.store.configureFrontend(parseConfigureRequest(value))
      await this.restart()
    })
    ipcMain.handle(USE_SERVER_CHANNEL, async (event) => {
      this.assertSender(event.sender.id)
      await this.store.useServer()
      await this.restart()
    })
    ipcMain.on(CLOSE_CHANNEL, (event) => {
      this.assertSender(event.sender.id)
      this.window?.close()
    })
  }

  async open(): Promise<void> {
    const existing = this.window
    if (existing !== undefined && !existing.isDestroyed()) {
      existing.show()
      existing.focus()
      return
    }
    const window = new BrowserWindow({
      title: 'Connect DSH Desktop to a Server',
      width: 520,
      height: 590,
      minWidth: 460,
      minHeight: 520,
      show: false,
      resizable: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        preload: fileURLToPath(new URL('./frontend-setup-preload.cjs', import.meta.url)),
      },
    })
    this.window = window
    window.setMenuBarVisibility(false)
    window.once('ready-to-show', () => { window.show() })
    window.once('closed', () => { if (this.window === window) this.window = undefined })
    await window.loadURL(frontendSetupPage())
  }

  dispose(): void {
    ipcMain.removeHandler(DESCRIBE_CHANNEL)
    ipcMain.removeHandler(CONFIGURE_CHANNEL)
    ipcMain.removeHandler(USE_SERVER_CHANNEL)
    ipcMain.removeAllListeners(CLOSE_CHANNEL)
    this.window?.destroy()
    this.window = undefined
  }

  private assertSender(senderId: number): void {
    if (this.window?.webContents.id !== senderId) {
      throw new Error('dsh-plugin-desktop: rejected Frontend setup IPC from another window')
    }
  }
}

function parseConfigureRequest(value: unknown): ConfigureFrontendRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('dsh-plugin-desktop: invalid Frontend setup request')
  }
  const record = value as Record<string, unknown>
  if (typeof record.endpoint !== 'string'
    || typeof record.pairingCode !== 'string'
    || typeof record.deviceName !== 'string') {
    throw new Error('dsh-plugin-desktop: Frontend setup fields must be strings')
  }
  return {
    endpoint: record.endpoint,
    pairingCode: record.pairingCode,
    deviceName: record.deviceName,
  }
}

function frontendSetupPage(): string {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
  <title>连接 DSH Server</title>
  <style>
    :root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC",sans-serif;background:#111318;color:#eef1f7}
    *{box-sizing:border-box}body{margin:0;padding:30px;background:linear-gradient(145deg,#161922,#0d0f14);min-height:100vh}
    h1{font-size:24px;margin:0 0 8px}p{color:#aeb6c6;line-height:1.5;margin:0 0 24px}
    label{display:block;font-size:13px;color:#c7cedb;margin:16px 0 6px}input{width:100%;padding:12px 13px;border:1px solid #343b49;border-radius:10px;background:#1d222d;color:#f5f7fb;font-size:14px;outline:none}input:focus{border-color:#4c8dff}
    .actions{display:flex;gap:10px;margin-top:24px}.actions button{flex:1;border:0;border-radius:10px;padding:12px;font-weight:650;cursor:pointer}.primary{background:#2f7df6;color:white}.secondary{background:#2a303d;color:#e9edf5}
    #status{min-height:42px;margin-top:18px;padding:10px 12px;border-radius:9px;background:#171b24;color:#aeb6c6;font-size:13px}.error{color:#ff9e9e!important}
    small{display:block;color:#7f899b;margin-top:8px;line-height:1.45}
  </style>
</head>
<body>
  <h1>连接远程 DSH Server</h1>
  <p>Frontend 只显示和控制远端状态，不会启动本机 DSH Host。</p>
  <form id="form">
    <label for="endpoint">Server 地址</label>
    <input id="endpoint" type="url" placeholder="https://dsh.example" required>
    <small>MacBook 通过受控 SSH 隧道访问 http://127.0.0.1 时不需要二次配对；其他远端必须使用 HTTPS。</small>
    <label for="code" id="code-label">8 位配对码（仅远程 HTTPS）</label>
    <input id="code" inputmode="numeric" pattern="[0-9]{8}" maxlength="8">
    <label for="device">设备名称</label>
    <input id="device" maxlength="100" value="MacBook" required>
    <div class="actions"><button class="primary" type="submit">连接并切换</button><button class="secondary" id="local" type="button">使用本机 Server</button></div>
  </form>
  <div id="status">正在读取当前配置…</div>
  <script>
    const api=window.dshFrontendSetup,status=document.getElementById('status'),endpoint=document.getElementById('endpoint'),code=document.getElementById('code'),device=document.getElementById('device'),form=document.getElementById('form');
    const updateAuth=()=>{try{const host=new URL(endpoint.value).hostname,loopback=host==='127.0.0.1'||host==='localhost'||host==='[::1]';code.required=!loopback;code.disabled=loopback;code.placeholder=loopback?'SSH 隧道已认证，无需配对码':'请输入 Server 生成的 8 位配对码'}catch{code.required=true;code.disabled=false}};
    endpoint.addEventListener('input',updateAuth);
    api.describe().then(value=>{endpoint.value=value.endpoint;device.value=value.deviceName||'MacBook';updateAuth();status.textContent=value.role==='frontend'?'当前使用远程 Frontend。':'当前使用本机 Server。'}).catch(error=>{status.className='error';status.textContent=String(error)});
    form.addEventListener('submit',event=>{event.preventDefault();status.className='';status.textContent='正在配对…';api.configure({endpoint:endpoint.value,pairingCode:document.getElementById('code').value,deviceName:device.value}).catch(error=>{status.className='error';status.textContent=String(error)})});
    document.getElementById('local').addEventListener('click',()=>{status.className='';status.textContent='正在切换…';api.useServer().catch(error=>{status.className='error';status.textContent=String(error)})});
  </script>
</body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}
