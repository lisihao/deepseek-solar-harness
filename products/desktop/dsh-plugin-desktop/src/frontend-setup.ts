/** Native pairing window for selecting a remote DSH Server before Host startup. */

import { BrowserWindow, ipcMain } from 'electron'
import { fileURLToPath } from 'node:url'
import {
  activeFrontendServer,
  type ConfigureFrontendRequest,
  type DesktopDeploymentState,
  DesktopDeploymentStateStore,
} from './deployment-state.ts'

const DESCRIBE_CHANNEL = 'dsh-desktop:frontend-setup:describe'
const CONFIGURE_CHANNEL = 'dsh-desktop:frontend-setup:configure'
const SELECT_CHANNEL = 'dsh-desktop:frontend-setup:select'
const REMOVE_CHANNEL = 'dsh-desktop:frontend-setup:remove'
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
      const active = state.role === 'frontend' ? activeFrontendServer(state) : undefined
      return {
        role: state.role,
        activeServerId: state.role === 'frontend' ? state.activeServerId : '',
        servers: state.role === 'frontend' ? state.servers.map(server => ({
          id: server.id,
          label: server.label,
          endpoint: server.endpoint,
          deviceName: server.deviceName,
          authMode: server.authMode,
        })) : [],
        endpoint: active?.endpoint ?? '',
        deviceName: active?.deviceName ?? '',
      }
    })
    ipcMain.handle(CONFIGURE_CHANNEL, async (event, value: unknown) => {
      this.assertSender(event.sender.id)
      await this.store.configureFrontend(parseConfigureRequest(value))
      await this.restart()
    })
    ipcMain.handle(SELECT_CHANNEL, async (event, value: unknown) => {
      this.assertSender(event.sender.id)
      await this.store.selectFrontend(parseServerId(value))
      await this.restart()
    })
    ipcMain.handle(REMOVE_CHANNEL, async (event, value: unknown) => {
      this.assertSender(event.sender.id)
      await this.store.removeFrontend(parseServerId(value))
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
      height: 720,
      minWidth: 460,
      minHeight: 640,
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
    ipcMain.removeHandler(SELECT_CHANNEL)
    ipcMain.removeHandler(REMOVE_CHANNEL)
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
    ...(typeof record.serverId === 'string' && record.serverId !== '' ? { serverId: record.serverId } : {}),
    ...(typeof record.label === 'string' ? { label: record.label } : {}),
    endpoint: record.endpoint,
    pairingCode: record.pairingCode,
    deviceName: record.deviceName,
  }
}

function parseServerId(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('dsh-plugin-desktop: Frontend Server id must be a non-empty string')
  }
  return value.trim()
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
    label{display:block;font-size:13px;color:#c7cedb;margin:16px 0 6px}input,select{width:100%;padding:12px 13px;border:1px solid #343b49;border-radius:10px;background:#1d222d;color:#f5f7fb;font-size:14px;outline:none}input:focus,select:focus{border-color:#4c8dff}
    .actions{display:flex;gap:10px;margin-top:24px}.actions button{flex:1;border:0;border-radius:10px;padding:12px;font-weight:650;cursor:pointer}.primary{background:#2f7df6;color:white}.secondary{background:#2a303d;color:#e9edf5}
    .server-actions{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:8px}.server-actions button{border:1px solid #343b49;border-radius:8px;padding:9px;background:#202632;color:#e9edf5;cursor:pointer}.danger{color:#ffb0b0!important}
    #status{min-height:42px;margin-top:18px;padding:10px 12px;border-radius:9px;background:#171b24;color:#aeb6c6;font-size:13px}.error{color:#ff9e9e!important}
    small{display:block;color:#7f899b;margin-top:8px;line-height:1.45}
  </style>
</head>
<body>
  <h1>连接远程 DSH Server</h1>
  <p>一个 Frontend 可以保存多个 DSH Server。选择当前 Server 后，应用会重启并连接对应的远端状态。</p>
  <label for="servers">已配置 Server</label>
  <select id="servers"><option value="">尚未配置</option></select>
  <div class="server-actions"><button id="switch" type="button">切换到选中项</button><button id="new" type="button">新增 Server</button><button class="danger" id="remove" type="button">删除选中项</button></div>
  <form id="form">
    <label for="label">显示名称</label>
    <input id="label" maxlength="100" placeholder="例如：Mac mini 主服务器" required>
    <label for="endpoint">Server 地址</label>
    <input id="endpoint" type="url" placeholder="https://dsh.example" required>
    <small>MacBook 通过受控 SSH 隧道访问 http://127.0.0.1 时不需要二次配对；其他远端必须使用 HTTPS。</small>
    <label for="code" id="code-label">8 位配对码（仅远程 HTTPS）</label>
    <input id="code" inputmode="numeric" pattern="[0-9]{8}" maxlength="8">
    <label for="device">设备名称</label>
    <input id="device" maxlength="100" value="MacBook" required>
    <div class="actions"><button class="primary" type="submit">保存并连接</button><button class="secondary" id="local" type="button">使用本机 Server</button></div>
  </form>
  <div id="status">正在读取当前配置…</div>
  <script>
    const api=window.dshFrontendSetup,status=document.getElementById('status'),servers=document.getElementById('servers'),label=document.getElementById('label'),endpoint=document.getElementById('endpoint'),code=document.getElementById('code'),device=document.getElementById('device'),form=document.getElementById('form');let current={role:'server',activeServerId:'',servers:[]},editingId='';
    const updateAuth=()=>{try{const url=new URL(endpoint.value),host=url.hostname,loopback=host==='127.0.0.1'||host==='localhost'||host==='[::1]',saved=current.servers.find(item=>item.id===editingId),reuse=saved?.authMode==='paired'&&saved.endpoint===url.href&&saved.deviceName===device.value;code.required=!loopback&&!reuse;code.disabled=loopback;code.placeholder=loopback?'SSH 隧道已认证，无需配对码':reuse?'凭据未变化，留空即可复用':'请输入 Server 生成的 8 位配对码'}catch{code.required=true;code.disabled=false}};
    const loadServer=id=>{const server=current.servers.find(item=>item.id===id);editingId=server?.id||'';label.value=server?.label||'';endpoint.value=server?.endpoint||'';device.value=server?.deviceName||'MacBook';code.value='';updateAuth()};
    const render=value=>{current=value;servers.replaceChildren();if(value.servers.length===0){const option=document.createElement('option');option.value='';option.textContent='尚未配置';servers.append(option)}else for(const server of value.servers){const option=document.createElement('option');option.value=server.id;option.textContent=server.label+' · '+server.endpoint;servers.append(option)}servers.value=value.activeServerId||value.servers[0]?.id||'';loadServer(servers.value);status.textContent=value.role==='frontend'?'当前 Frontend 已保存 '+value.servers.length+' 个 Server。':'当前使用本机 Server。'};
    endpoint.addEventListener('input',updateAuth);
    device.addEventListener('input',updateAuth);
    servers.addEventListener('change',()=>{loadServer(servers.value)});
    document.getElementById('new').addEventListener('click',()=>{editingId='';servers.value='';label.value='';endpoint.value='';code.value='';device.value='MacBook';updateAuth();status.className='';status.textContent='填写新 Server 配置。'});
    document.getElementById('switch').addEventListener('click',()=>{if(!servers.value)return;status.className='';status.textContent='正在切换 Server…';api.select(servers.value).catch(error=>{status.className='error';status.textContent=String(error)})});
    document.getElementById('remove').addEventListener('click',()=>{if(!servers.value)return;if(!confirm('删除这个 Server 配置？凭据也会从 DSH Desktop 配置中移除。'))return;status.className='';status.textContent='正在删除…';api.remove(servers.value).catch(error=>{status.className='error';status.textContent=String(error)})});
    api.describe().then(render).catch(error=>{status.className='error';status.textContent=String(error)});
    form.addEventListener('submit',event=>{event.preventDefault();status.className='';status.textContent='正在保存并连接…';api.configure({serverId:editingId,label:label.value,endpoint:endpoint.value,pairingCode:code.value,deviceName:device.value}).catch(error=>{status.className='error';status.textContent=String(error)})});
    document.getElementById('local').addEventListener('click',()=>{status.className='';status.textContent='正在切换…';api.useServer().catch(error=>{status.className='error';status.textContent=String(error)})});
  </script>
</body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}
