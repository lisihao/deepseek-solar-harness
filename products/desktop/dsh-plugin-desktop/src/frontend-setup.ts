/** Native pairing window for selecting a remote DSH Server before Host startup. */

import { BrowserWindow, ipcMain } from 'electron'
import { fileURLToPath } from 'node:url'
import {
  activeFrontendServer,
  type ConfigureFrontendRequest,
  type DesktopDeploymentState,
  DesktopDeploymentStateStore,
} from './deployment-state.ts'
import { DesktopGitSyncController, type DesktopGitSyncConfigureRequest } from './git-sync.ts'
import {
  DesktopSessionSyncController, type DesktopSessionSyncConfigureRequest,
} from './session-sync.ts'

const DESCRIBE_CHANNEL = 'dsh-desktop:frontend-setup:describe'
const CONFIGURE_CHANNEL = 'dsh-desktop:frontend-setup:configure'
const SELECT_CHANNEL = 'dsh-desktop:frontend-setup:select'
const REMOVE_CHANNEL = 'dsh-desktop:frontend-setup:remove'
const USE_SERVER_CHANNEL = 'dsh-desktop:frontend-setup:use-server'
const GIT_SYNC_CONFIGURE_CHANNEL = 'dsh-desktop:frontend-setup:git-sync-configure'
const GIT_SYNC_RUN_CHANNEL = 'dsh-desktop:frontend-setup:git-sync-run'
const SESSION_SYNC_CONFIGURE_CHANNEL = 'dsh-desktop:frontend-setup:session-sync-configure'
const SESSION_SYNC_RUN_CHANNEL = 'dsh-desktop:frontend-setup:session-sync-run'
const CLOSE_CHANNEL = 'dsh-desktop:frontend-setup:close'

export class FrontendSetupController {
  private window: BrowserWindow | undefined

  constructor(
    private readonly store: DesktopDeploymentStateStore,
    private readonly gitSync: DesktopGitSyncController,
    private readonly sessionSync: DesktopSessionSyncController,
    private readonly readState: () => DesktopDeploymentState,
    private readonly restart: () => Promise<void>,
  ) {
    ipcMain.handle(DESCRIBE_CHANNEL, event => {
      this.assertSender(event.sender.id)
      const state = this.readState()
      const active = state.role === 'frontend' ? activeFrontendServer(state) : undefined
      return {
        role: state.role,
        activeServerId: state.activeServerId ?? '',
        servers: state.servers.map(server => ({
          id: server.id,
          label: server.label,
          endpoint: server.endpoint,
          deviceName: server.deviceName,
          authMode: server.authMode,
        })),
        endpoint: active?.endpoint ?? '',
        deviceName: active?.deviceName ?? '',
        gitSync: this.gitSync.snapshot(),
        sessionSync: this.sessionSync.snapshot(),
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
    ipcMain.handle(GIT_SYNC_CONFIGURE_CHANNEL, async (event, value: unknown) => {
      this.assertSender(event.sender.id)
      return await this.gitSync.configure(value as DesktopGitSyncConfigureRequest)
    })
    ipcMain.handle(GIT_SYNC_RUN_CHANNEL, async (event) => {
      this.assertSender(event.sender.id)
      return await this.gitSync.runNow()
    })
    ipcMain.handle(SESSION_SYNC_CONFIGURE_CHANNEL, async (event, value: unknown) => {
      this.assertSender(event.sender.id)
      return await this.sessionSync.configure(value as DesktopSessionSyncConfigureRequest)
    })
    ipcMain.handle(SESSION_SYNC_RUN_CHANNEL, async (event) => {
      this.assertSender(event.sender.id)
      return await this.sessionSync.runNow()
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
    ipcMain.removeHandler(GIT_SYNC_CONFIGURE_CHANNEL)
    ipcMain.removeHandler(GIT_SYNC_RUN_CHANNEL)
    ipcMain.removeHandler(SESSION_SYNC_CONFIGURE_CHANNEL)
    ipcMain.removeHandler(SESSION_SYNC_RUN_CHANNEL)
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
    h1{font-size:24px;margin:0 0 8px}h2{font-size:18px;margin:30px 0 8px}p{color:#aeb6c6;line-height:1.5;margin:0 0 24px}
    label{display:block;font-size:13px;color:#c7cedb;margin:16px 0 6px}input,select{width:100%;padding:12px 13px;border:1px solid #343b49;border-radius:10px;background:#1d222d;color:#f5f7fb;font-size:14px;outline:none}input:focus,select:focus{border-color:#4c8dff}
    .actions{display:flex;gap:10px;margin-top:24px}.actions button{flex:1;border:0;border-radius:10px;padding:12px;font-weight:650;cursor:pointer}.primary{background:#2f7df6;color:white}.secondary{background:#2a303d;color:#e9edf5}
    .server-actions{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:8px}.server-actions button{border:1px solid #343b49;border-radius:8px;padding:9px;background:#202632;color:#e9edf5;cursor:pointer}.danger{color:#ffb0b0!important}
    #status{min-height:42px;margin-top:18px;padding:10px 12px;border-radius:9px;background:#171b24;color:#aeb6c6;font-size:13px}.error{color:#ff9e9e!important}
    small{display:block;color:#7f899b;margin-top:8px;line-height:1.45}.inline{display:flex;align-items:center;gap:10px;margin:12px 0}.inline input{width:auto}.inline label{margin:0}.sync-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}.sync-grid .wide{grid-column:1/-1}
    .role-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:18px 0 26px}.role-card{border:1px solid #343b49;border-radius:12px;padding:13px;background:#171b24}.role-card strong{display:block;color:#f3f6fc;font-size:14px;margin-bottom:5px}.role-card span{display:block;color:#8f99aa;font-size:12px;line-height:1.45}.boundary{border-left:3px solid #4c8dff;background:#171b24;border-radius:0 10px 10px 0;padding:11px 13px;color:#aeb6c6;font-size:12px;line-height:1.55;margin:10px 0 18px}
  </style>
</head>
<body>
  <h1>连接远程 DSH Server</h1>
  <p>一个 Frontend 可以保存多个 DSH Server。手动选择会重启并建立新的权威入口；运行中的 Leader 变化会自动重选并重新挂载，不需要重启应用。</p>
  <div class="role-grid"><div class="role-card"><strong>本机 Server</strong><span>在这台 MacBook 启动完整 Host 与全部本地插件，数据与执行权威都在本机。</span></div><div class="role-card"><strong>远程 Frontend</strong><span>只渲染所选 Server 的插件与状态，不在 MacBook 偷启第二个 Host；可保存多个 Server 并跟随 Leader。</span></div></div>
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
  <h2>后台 Git commit 同步</h2>
  <p>只同步干净工作树中已经提交的 commit。不会复制 DSH Session、SQLite/WAL，也不会自动提交修改。GitHub remote 始终是权威；可选 Tailscale/SSH Git remote 只预取对象。</p>
  <div class="boundary"><strong>同步边界：</strong>Git 只搬运源码 commit，不搬运正在执行的任务或数据库。远端 Server 仍是其 active Run 的唯一写者。</div>
  <div class="inline"><input id="sync-enabled" type="checkbox"><label for="sync-enabled">启动后台同步</label><label for="sync-interval">间隔（分钟）</label><input id="sync-interval" type="number" min="1" max="1440" value="10"></div>
  <label for="sync-repositories">已配置仓库</label>
  <select id="sync-repositories"><option value="">尚未配置</option></select>
  <div class="server-actions"><button id="sync-new" type="button">新增仓库</button><button class="danger" id="sync-remove" type="button">删除选中项</button><button id="sync-run" type="button">立即同步</button></div>
  <div class="sync-grid">
    <div class="wide"><label for="sync-label">显示名称</label><input id="sync-label" maxlength="100" placeholder="例如：DSH 主仓"></div>
    <div class="wide"><label for="sync-path">本机仓库绝对路径</label><input id="sync-path" maxlength="4096" placeholder="/Users/name/Projects/project"></div>
    <div><label for="sync-authority">GitHub 权威 remote</label><input id="sync-authority" value="origin" maxlength="200"></div>
    <div><label for="sync-branch">分支</label><input id="sync-branch" value="main" maxlength="200"></div>
    <div><label for="sync-direction">方向</label><select id="sync-direction"><option value="bidirectional">双向快进</option><option value="pull">只拉取</option><option value="push">只推送</option></select></div>
    <div><label for="sync-accelerator">Tailscale/SSH 加速 remote（可选）</label><input id="sync-accelerator" maxlength="200" placeholder="例如 macmini"></div>
  </div>
  <div class="actions"><button class="primary" id="sync-save" type="button">保存同步设置</button></div>
  <div id="sync-status">尚未运行 Git 同步。</div>
  <h2>后台 Session 进展同步</h2>
  <p>存活回合由 Frontend 实时查看；这里只快进复制已经闭合的 Session 日志。Frontend 模式会先安全暂存，切到本机 Server 后导入；不会复制 SQLite/WAL，也不会建立两个写者。</p>
  <div class="boundary"><strong>同步边界：</strong>只同步已经闭合且前缀一致的 Session 日志。进行中的回合通过远端投影查看，不会在本机继续写入。</div>
  <div class="inline"><input id="session-sync-enabled" type="checkbox"><label for="session-sync-enabled">启动后台同步</label><label for="session-sync-interval">间隔（分钟）</label><input id="session-sync-interval" type="number" min="1" max="1440" value="10"></div>
  <label for="session-sync-direction">方向</label>
  <select id="session-sync-direction"><option value="pull">远端 → 本机</option><option value="push">本机 → 远端</option><option value="bidirectional">双向快进</option></select>
  <div class="actions"><button class="primary" id="session-sync-save" type="button">保存 Session 同步</button><button class="secondary" id="session-sync-run" type="button">立即同步</button></div>
  <div id="session-sync-status">尚未运行 Session 同步。</div>
  <div id="status">正在读取当前配置…</div>
  <script>
    const api=window.dshFrontendSetup,status=document.getElementById('status'),servers=document.getElementById('servers'),label=document.getElementById('label'),endpoint=document.getElementById('endpoint'),code=document.getElementById('code'),device=document.getElementById('device'),form=document.getElementById('form'),syncEnabled=document.getElementById('sync-enabled'),syncInterval=document.getElementById('sync-interval'),syncRepositoriesSelect=document.getElementById('sync-repositories'),syncLabel=document.getElementById('sync-label'),syncPath=document.getElementById('sync-path'),syncAuthority=document.getElementById('sync-authority'),syncBranch=document.getElementById('sync-branch'),syncDirection=document.getElementById('sync-direction'),syncAccelerator=document.getElementById('sync-accelerator'),syncStatus=document.getElementById('sync-status'),sessionSyncEnabled=document.getElementById('session-sync-enabled'),sessionSyncInterval=document.getElementById('session-sync-interval'),sessionSyncDirection=document.getElementById('session-sync-direction'),sessionSyncStatus=document.getElementById('session-sync-status');let current={role:'server',activeServerId:'',servers:[]},editingId='',syncRepositories=[],editingSyncId='';
    const updateAuth=()=>{try{const url=new URL(endpoint.value),host=url.hostname,loopback=host==='127.0.0.1'||host==='localhost'||host==='[::1]',saved=current.servers.find(item=>item.id===editingId),reuse=saved?.authMode==='paired'&&saved.endpoint===url.href&&saved.deviceName===device.value;code.required=!loopback&&!reuse;code.disabled=loopback;code.placeholder=loopback?'SSH 隧道已认证，无需配对码':reuse?'凭据未变化，留空即可复用':'请输入 Server 生成的 8 位配对码'}catch{code.required=true;code.disabled=false}};
    const loadServer=id=>{const server=current.servers.find(item=>item.id===id);editingId=server?.id||'';label.value=server?.label||'';endpoint.value=server?.endpoint||'';device.value=server?.deviceName||'MacBook';code.value='';updateAuth()};
    const render=value=>{current=value;servers.replaceChildren();if(value.servers.length===0){const option=document.createElement('option');option.value='';option.textContent='尚未配置';servers.append(option)}else for(const server of value.servers){const option=document.createElement('option');option.value=server.id;option.textContent=(server.id===value.activeServerId?'● ':'')+server.label+' · '+server.endpoint;servers.append(option)}servers.value=value.activeServerId||value.servers[0]?.id||'';loadServer(servers.value);status.textContent=value.role==='frontend'?'远程 Frontend · 已保存 '+value.servers.length+' 个 Server · 自动跟随可调度 Leader。':'本机 Server · 完整 Host 与插件在此设备运行。'};
    endpoint.addEventListener('input',updateAuth);
    device.addEventListener('input',updateAuth);
    servers.addEventListener('change',()=>{loadServer(servers.value)});
    document.getElementById('new').addEventListener('click',()=>{editingId='';servers.value='';label.value='';endpoint.value='';code.value='';device.value='MacBook';updateAuth();status.className='';status.textContent='填写新 Server 配置。'});
    document.getElementById('switch').addEventListener('click',()=>{if(!servers.value)return;status.className='';status.textContent='正在切换 Server…';api.select(servers.value).catch(error=>{status.className='error';status.textContent=String(error)})});
    document.getElementById('remove').addEventListener('click',()=>{if(!servers.value)return;if(!confirm('删除这个 Server 配置？凭据也会从 DSH Desktop 配置中移除。'))return;status.className='';status.textContent='正在删除…';api.remove(servers.value).catch(error=>{status.className='error';status.textContent=String(error)})});
    const loadSyncRepository=id=>{const repository=syncRepositories.find(item=>item.id===id);editingSyncId=repository?.id||'';syncLabel.value=repository?.label||'';syncPath.value=repository?.repositoryPath||'';syncAuthority.value=repository?.authorityRemote||'origin';syncBranch.value=repository?.branch||'main';syncDirection.value=repository?.direction||'bidirectional';syncAccelerator.value=repository?.acceleratorRemote||''};
    const renderGitSync=value=>{syncEnabled.checked=value.enabled;syncInterval.value=String(value.intervalMinutes);syncRepositories=[...value.repositories];syncRepositoriesSelect.replaceChildren();if(syncRepositories.length===0){const option=document.createElement('option');option.value='';option.textContent='尚未配置';syncRepositoriesSelect.append(option)}else for(const repository of syncRepositories){const option=document.createElement('option');option.value=repository.id;option.textContent=repository.label+' · '+repository.branch;syncRepositoriesSelect.append(option)}syncRepositoriesSelect.value=editingSyncId&&syncRepositories.some(item=>item.id===editingSyncId)?editingSyncId:syncRepositories[0]?.id||'';loadSyncRepository(syncRepositoriesSelect.value);const details=value.results.map(result=>{const repository=syncRepositories.find(item=>item.id===result.repositoryId);return (repository?.label||result.repositoryId)+'：'+result.message}).join('\\n');syncStatus.textContent=value.running?'同步运行中…':details||'尚未运行 Git 同步。'};
    const renderSessionSync=value=>{sessionSyncEnabled.checked=value.enabled;sessionSyncInterval.value=String(value.intervalMinutes);sessionSyncDirection.value=value.direction;const details=value.results.map(result=>(result.sessionId?result.sessionId+'：':'')+result.message).join('\\n');sessionSyncStatus.textContent=value.running?'Session 同步运行中…':details||'尚未运行 Session 同步。'};
    api.describe().then(value=>{render(value);renderGitSync(value.gitSync);renderSessionSync(value.sessionSync)}).catch(error=>{status.className='error';status.textContent=String(error)});
    form.addEventListener('submit',event=>{event.preventDefault();status.className='';status.textContent='正在保存并连接…';api.configure({serverId:editingId,label:label.value,endpoint:endpoint.value,pairingCode:code.value,deviceName:device.value}).catch(error=>{status.className='error';status.textContent=String(error)})});
    document.getElementById('local').addEventListener('click',()=>{status.className='';status.textContent='正在切换…';api.useServer().catch(error=>{status.className='error';status.textContent=String(error)})});
    syncRepositoriesSelect.addEventListener('change',()=>{loadSyncRepository(syncRepositoriesSelect.value)});
    document.getElementById('sync-new').addEventListener('click',()=>{editingSyncId='';syncRepositoriesSelect.value='';syncLabel.value='';syncPath.value='';syncAuthority.value='origin';syncBranch.value='main';syncDirection.value='bidirectional';syncAccelerator.value='';syncStatus.textContent='填写新的本机 Git 仓库。'});
    document.getElementById('sync-remove').addEventListener('click',()=>{if(!syncRepositoriesSelect.value)return;syncRepositories=syncRepositories.filter(item=>item.id!==syncRepositoriesSelect.value);editingSyncId='';api.configureGitSync({enabled:syncEnabled.checked,intervalMinutes:Number(syncInterval.value),repositories:syncRepositories}).then(renderGitSync).catch(error=>{syncStatus.className='error';syncStatus.textContent=String(error)})});
    document.getElementById('sync-save').addEventListener('click',()=>{const id=editingSyncId||'repo-'+Date.now(),repository={id,label:syncLabel.value,repositoryPath:syncPath.value,authorityRemote:syncAuthority.value,branch:syncBranch.value,direction:syncDirection.value,...syncAccelerator.value?{acceleratorRemote:syncAccelerator.value}:{}};const index=syncRepositories.findIndex(item=>item.id===id);if(index>=0)syncRepositories[index]=repository;else syncRepositories.push(repository);editingSyncId=id;syncStatus.className='';syncStatus.textContent='正在保存同步设置…';api.configureGitSync({enabled:syncEnabled.checked,intervalMinutes:Number(syncInterval.value),repositories:syncRepositories}).then(renderGitSync).catch(error=>{syncStatus.className='error';syncStatus.textContent=String(error)})});
    document.getElementById('sync-run').addEventListener('click',()=>{syncStatus.className='';syncStatus.textContent='正在同步已提交的 Git commit…';api.runGitSync().then(renderGitSync).catch(error=>{syncStatus.className='error';syncStatus.textContent=String(error)})});
    document.getElementById('session-sync-save').addEventListener('click',()=>{sessionSyncStatus.className='';sessionSyncStatus.textContent='正在保存 Session 同步设置…';api.configureSessionSync({enabled:sessionSyncEnabled.checked,intervalMinutes:Number(sessionSyncInterval.value),direction:sessionSyncDirection.value}).then(renderSessionSync).catch(error=>{sessionSyncStatus.className='error';sessionSyncStatus.textContent=String(error)})});
    document.getElementById('session-sync-run').addEventListener('click',()=>{sessionSyncStatus.className='';sessionSyncStatus.textContent='正在同步闭合的 Session 日志…';api.runSessionSync().then(renderSessionSync).catch(error=>{sessionSyncStatus.className='error';sessionSyncStatus.textContent=String(error)})});
  </script>
</body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}
