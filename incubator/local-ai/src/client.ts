import { createElement as h, useCallback, useEffect, useState, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { LlmDiscoveredModel, SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SlotComponent } from '@deepseek-ai/dsh-client-ui-slots'
import {
  DEFAULT_GATEWAY_PORT,
  DEFAULT_TAILSCALE_PROXY,
  LOCAL_AI_API,
  LOCAL_AI_KEY_REF,
  LOCAL_AI_PROVIDER,
  NO_KEY_PLACEHOLDER,
  fromGatewayBaseURL,
  isTailnetHost,
  modelFromDiscovery,
  normalizeEndpoint,
  providerProfile,
  toGatewayBaseURL,
  type LocalAiModel,
} from './endpoint.js'
import type { LocalAiLocaleKey } from './slot-contract.js'
import type {} from './slot-contract.js'

export const LOCAL_AI_LOCALE_NAMESPACE = 'settings.localAi' as const
export const LOCAL_AI_STYLE_ID = 'dsh-solar-local-ai-style'
/** Profile entry id of this plugin's Host half (see cordis.patch.yml). */
export const LOCAL_AI_ENTRY = 'solar-local-ai' as const
export const PI_AI_NAMESPACE = 'llm-pi-ai' as const
const SUBSCRIPTIONS_PAGE_SLOT = 'settings.subscriptions.page'
const SETTINGS_SECTION_SLOT = 'settings.section'

export const inject = ['slots', 'locale', 'remote'] as const

const dictionaries = {
  zh: {
    nav: '本地 AI',
    title: '本地 AI',
    intro: '连接你自己部署的 OpenAI 兼容服务（如 oMLX、vLLM、LM Studio、Ollama）。刷新模型并保存后，即可在对话框的模型选择中使用。',
    mode: '连接方式',
    modeDirect: '局域网 / 直连',
    modeTailscale: 'Tailscale（用户态）',
    tailscaleHelp: '适用于以 userspace-networking 方式运行的 tailscaled：插件在本机 127.0.0.1 开一个转发网关，经 tailscaled 的 SOCKS5 代理访问 tailnet 中的服务。只转发 Tailscale 地址。',
    endpoint: '服务地址',
    endpointPlaceholder: 'http://192.168.2.200:8000/v1',
    endpointPlaceholderTailscale: 'http://100.114.161.62:8000/v1 或 http://主机名.ts.net:8000/v1',
    proxy: 'Tailscale SOCKS5 代理',
    gatewayPort: '本机网关端口',
    displayName: '显示名称',
    defaultDisplayName: '本地 AI',
    apiKey: 'API Key（可选）',
    apiKeyPlaceholder: '服务不需要 Key 时留空',
    apiKeySaved: '已保存；留空则保持不变',
    showKey: '显示 Key',
    hideKey: '隐藏 Key',
    refresh: '刷新模型',
    refreshing: '正在刷新…',
    models: '可用模型',
    contextWindow: '上下文 {count}',
    selectAll: '全选',
    deselectAll: '全不选',
    save: '保存并启用',
    saving: '正在保存…',
    remove: '移除',
    removing: '正在移除…',
    current: '当前：{name}，{count} 个模型，{route}',
    currentDirect: '直连',
    currentTailscale: '经 Tailscale 网关',
    notConfigured: '尚未配置本地 AI。',
    saved: '已保存，{count} 个模型已加入模型选择。',
    removed: '已移除本地 AI。',
    loading: '正在读取设置…',
    loadFailed: '读取设置失败：{message}',
    invalidEndpoint: '地址无效，请填写形如 http://主机:端口/v1 的地址。',
    tailnetOnly: 'Tailscale 模式只支持 http 协议的 100.64.0.0/10、fd7a:115c:a1e0::/48 或 *.ts.net 地址。',
    invalidProxy: '代理地址无效，请填写形如 socks5://127.0.0.1:1055 的地址。',
    invalidPort: '网关端口需在 1024 到 65535 之间。',
    noModels: '请先刷新模型，并至少选择一个。',
    fetchEmpty: '这个地址没有返回任何模型。',
    readOnly: '当前部署的设置是只读的，无法保存。',
    conflict: '设置刚在别处被修改，已重新读取，请再保存一次。',
    hostMissing: '模型适配器 llm-pi-ai 或本插件的 Host 部分未加载，无法保存。',
  },
  en: {
    nav: 'Local AI',
    title: 'Local AI',
    intro: 'Connect an OpenAI-compatible server you run yourself (oMLX, vLLM, LM Studio, Ollama, and similar). After you refresh and save its models, choose them from the composer’s model picker.',
    mode: 'Connection',
    modeDirect: 'LAN / direct',
    modeTailscale: 'Tailscale (userspace)',
    tailscaleHelp: 'For a tailscaled running with userspace networking: the plugin opens a forwarding gateway on 127.0.0.1 and reaches the tailnet service through tailscaled’s SOCKS5 proxy. Only Tailscale addresses are forwarded.',
    endpoint: 'Server address',
    endpointPlaceholder: 'http://192.168.2.200:8000/v1',
    endpointPlaceholderTailscale: 'http://100.114.161.62:8000/v1 or http://host.ts.net:8000/v1',
    proxy: 'Tailscale SOCKS5 proxy',
    gatewayPort: 'Local gateway port',
    displayName: 'Display name',
    defaultDisplayName: 'Local AI',
    apiKey: 'API key (optional)',
    apiKeyPlaceholder: 'Leave empty if the server needs no key',
    apiKeySaved: 'Saved; leave empty to keep it',
    showKey: 'Show key',
    hideKey: 'Hide key',
    refresh: 'Refresh models',
    refreshing: 'Refreshing…',
    models: 'Available models',
    contextWindow: 'Context {count}',
    selectAll: 'Select all',
    deselectAll: 'Deselect all',
    save: 'Save and enable',
    saving: 'Saving…',
    remove: 'Remove',
    removing: 'Removing…',
    current: 'Current: {name}, {count} models, {route}',
    currentDirect: 'direct',
    currentTailscale: 'through the Tailscale gateway',
    notConfigured: 'Local AI is not configured yet.',
    saved: 'Saved. {count} models were added to the model picker.',
    removed: 'Local AI was removed.',
    loading: 'Reading settings…',
    loadFailed: 'Reading settings failed: {message}',
    invalidEndpoint: 'Enter an address such as http://host:port/v1.',
    tailnetOnly: 'Tailscale mode accepts only http addresses in 100.64.0.0/10, fd7a:115c:a1e0::/48, or *.ts.net.',
    invalidProxy: 'Enter a proxy address such as socks5://127.0.0.1:1055.',
    invalidPort: 'The gateway port must be between 1024 and 65535.',
    noModels: 'Refresh the models and select at least one.',
    fetchEmpty: 'This address returned no models.',
    readOnly: 'Settings are read-only in this deployment.',
    conflict: 'Settings changed elsewhere and were reloaded; save again.',
    hostMissing: 'The llm-pi-ai model adapter or this plugin’s Host half is not loaded, so nothing can be saved.',
  },
} satisfies Record<'zh' | 'en', Record<LocalAiLocaleKey, string>>

const styleText = [
  '.dsh-localai{display:flex;min-width:0;flex-direction:column;gap:14px;padding-top:12px;color:var(--dsw-alias-label-primary);font-size:13px}',
  '.dsh-localai p{margin:0}',
  '.dsh-localai-muted{color:var(--dsw-alias-label-tertiary)}',
  '.dsh-localai-error{color:var(--dsw-alias-label-error)}',
  '.dsh-localai-ok{color:var(--dsw-alias-state-success-primary)}',
  '.dsh-localai-field{display:flex;min-width:0;flex-direction:column;gap:6px}',
  '.dsh-localai-label{color:var(--dsw-alias-label-secondary);font-weight:500}',
  '.dsh-localai-row{display:flex;min-width:0;flex-wrap:wrap;gap:12px}',
  '.dsh-localai-row>.dsh-localai-field{flex:1 1 180px}',
  '.dsh-localai-input{box-sizing:border-box;width:100%;min-width:0;height:32px;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;padding:0 10px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit}',
  '.dsh-localai-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
  '.dsh-localai-keywrap{display:flex;gap:6px}',
  '.dsh-localai-segment{display:inline-flex;flex-wrap:wrap;gap:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:3px;align-self:flex-start;max-width:100%}',
  ".dsh-localai-segment button{border:0;border-radius:6px;padding:4px 10px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;cursor:pointer}",
  ".dsh-localai-segment button[aria-pressed='true']{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}",
  '.dsh-localai-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
  '.dsh-localai-button{height:30px;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;padding:0 12px;background:transparent;color:inherit;font:inherit;cursor:pointer;white-space:nowrap}',
  '.dsh-localai-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-localai-button:disabled{cursor:default;opacity:.5}',
  ".dsh-localai-button[data-primary='true']{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}",
  ".dsh-localai-button[data-primary='true']:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}",
  ".dsh-localai-button[data-danger='true']:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}",
  '.dsh-localai-models{display:flex;min-width:0;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;max-height:260px;overflow:auto}',
  '.dsh-localai-model{display:flex;min-width:0;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid var(--dsw-alias-border-l2);cursor:pointer}',
  '.dsh-localai-model:last-child{border-bottom:0}',
  '.dsh-localai-model code{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsh-localai-models-head{display:flex;align-items:center;justify-content:space-between;gap:8px}',
].join('\n')

type Translate = (key: LocalAiLocaleKey, params?: Record<string, string | number>) => string

/** The Remote calls the page performs, isolated from React for testing. */
export interface LocalAiOperations {
  describe(): Promise<SettingsSnapshot>
  write(ns: string, ops: SettingsPathOpView[], revision: number): Promise<{ kind: 'written', revision: number } | { kind: 'conflict' } | { kind: 'refused', message: string }>
  discover(request: { baseURL: string, apiKey?: string, provider?: string }): Promise<{ kind: 'found', models: readonly LlmDiscoveredModel[] } | { kind: 'refused', message: string }>
  storeKey(value: string): Promise<string | undefined>
  removeKey(): Promise<string | undefined>
}

export interface TailscaleSettings {
  readonly enabled: boolean
  readonly port: number
  readonly proxy: string
}

export interface SavedRoute {
  readonly displayName: string
  readonly baseURL: string
  readonly models: readonly LocalAiModel[]
  /** Raw user-layer profile, so fields this page does not edit survive a save. */
  readonly raw: Record<string, unknown>
}

export interface SettingsSnapshot {
  readonly writable: boolean
  readonly piAi?: { readonly revision: number, readonly route?: SavedRoute }
  readonly self?: { readonly revision: number, readonly tailscale: TailscaleSettings }
  readonly keyConfigured: boolean
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function savedRoute(view: SettingsNamespaceView): SavedRoute | undefined {
  const raw = record(record(record(view.user)?.providers)?.[LOCAL_AI_PROVIDER])
  if (raw === undefined || typeof raw.baseURL !== 'string') return undefined
  const models = Array.isArray(raw.models)
    ? raw.models.filter((model): model is LocalAiModel => typeof record(model)?.id === 'string')
    : []
  return { displayName: typeof raw.displayName === 'string' ? raw.displayName : '', baseURL: raw.baseURL, models, raw }
}

function tailscaleOf(view: SettingsNamespaceView): TailscaleSettings {
  const value = record(record(view.value)?.tailscale)
  return {
    enabled: value?.enabled === true,
    port: typeof value?.port === 'number' ? value.port : DEFAULT_GATEWAY_PORT,
    proxy: typeof value?.proxy === 'string' ? value.proxy : DEFAULT_TAILSCALE_PROXY,
  }
}

export function createLocalAiOperations(remote: Context['remote']): LocalAiOperations {
  return {
    describe: async () => {
      const [settings, credentials] = await Promise.all([
        remote.settings.describe(),
        remote.credentials.describe([LOCAL_AI_KEY_REF]),
      ])
      if (!settings.ok) throw new Error(settings.error.message)
      const piAi = settings.value.namespaces.find(view => view.ns === PI_AI_NAMESPACE)
      const self = settings.value.namespaces.find(view => view.ns === LOCAL_AI_ENTRY)
      const route = piAi === undefined ? undefined : savedRoute(piAi)
      return {
        writable: settings.value.writable,
        ...(piAi === undefined ? {} : { piAi: { revision: piAi.revision, ...(route === undefined ? {} : { route }) } }),
        ...(self === undefined ? {} : { self: { revision: self.revision, tailscale: tailscaleOf(self) } }),
        keyConfigured: credentials.ok && credentials.value[LOCAL_AI_KEY_REF]?.configured === true,
      }
    },
    write: async (ns, ops, revision) => {
      const response = await remote.settings.mutate(ns, ops, revision)
      if (response.ok) return { kind: 'written', revision: response.value.revision }
      return response.error.code === 'settings/conflict' ? { kind: 'conflict' } : { kind: 'refused', message: response.error.message }
    },
    discover: async request => {
      const response = await remote.llm.discoverModels(PI_AI_NAMESPACE, { ...request, api: LOCAL_AI_API })
      return response.ok ? { kind: 'found', models: response.value } : { kind: 'refused', message: response.error.message }
    },
    storeKey: async value => {
      const response = await remote.credentials.set(LOCAL_AI_KEY_REF, value)
      return response.ok ? undefined : response.error.message
    },
    removeKey: async () => {
      const response = await remote.credentials.unset(LOCAL_AI_KEY_REF)
      return response.ok ? undefined : response.error.message
    },
  }
}

type Mode = 'direct' | 'tailscale'

interface FormState {
  readonly mode: Mode
  readonly endpoint: string
  readonly proxy: string
  readonly port: string
  readonly displayName: string
}

/** Initial form values recovered from the stored route and gateway settings. */
export function formFromSnapshot(snapshot: SettingsSnapshot, defaultName: string): FormState {
  const route = snapshot.piAi?.route
  const tailscale = snapshot.self?.tailscale
  const gateway = route === undefined ? undefined : fromGatewayBaseURL(route.baseURL)
  return {
    mode: gateway === undefined ? 'direct' : 'tailscale',
    endpoint: gateway?.endpoint ?? route?.baseURL ?? '',
    proxy: tailscale?.proxy ?? DEFAULT_TAILSCALE_PROXY,
    port: String(gateway?.port ?? tailscale?.port ?? DEFAULT_GATEWAY_PORT),
    displayName: route?.displayName.length ? route.displayName : defaultName,
  }
}

export type ResolvedTarget =
  | { readonly kind: 'ok', readonly baseURL: string, readonly tailscale?: TailscaleSettings }
  | { readonly kind: 'invalid', readonly reason: 'invalidEndpoint' | 'tailnetOnly' | 'invalidProxy' | 'invalidPort' }

/** Validate the form and compute the route baseURL plus the gateway it needs. */
export function resolveTarget(form: FormState): ResolvedTarget {
  const endpoint = normalizeEndpoint(form.endpoint)
  if (endpoint === undefined) return { kind: 'invalid', reason: 'invalidEndpoint' }
  if (form.mode === 'direct') return { kind: 'ok', baseURL: endpoint }
  const url = new URL(endpoint)
  if (url.protocol !== 'http:' || !isTailnetHost(url.hostname)) return { kind: 'invalid', reason: 'tailnetOnly' }
  if (!/^socks5h?:\/\/[^/\s]+:\d{1,5}\/?$/.test(form.proxy.trim())) return { kind: 'invalid', reason: 'invalidProxy' }
  const port = Number(form.port)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return { kind: 'invalid', reason: 'invalidPort' }
  const baseURL = toGatewayBaseURL(endpoint, port)
  /* v8 ignore next -- the checks above are the same ones toGatewayBaseURL applies */
  if (baseURL === undefined) return { kind: 'invalid', reason: 'tailnetOnly' }
  return { kind: 'ok', baseURL, tailscale: { enabled: true, port, proxy: form.proxy.trim() } }
}

function sameTailscale(left: TailscaleSettings | undefined, right: TailscaleSettings): boolean {
  return left !== undefined && left.enabled === right.enabled && left.port === right.port && left.proxy === right.proxy
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

type Status = { readonly tone: 'muted' | 'error' | 'ok', readonly text: string } | undefined

type LocalAiPageProps = {
  readonly operations: LocalAiOperations
  readonly t: Translate
}

function field(label: string, control: ReactNode, key: string): ReactNode {
  return h('label', { key, className: 'dsh-localai-field' }, h('span', { className: 'dsh-localai-label' }, label), control)
}

export function LocalAiPage(props: LocalAiPageProps): ReactNode {
  const { operations, t } = props
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | undefined>(undefined)
  const [form, setForm] = useState<FormState | undefined>(undefined)
  const [key, setKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [candidates, setCandidates] = useState<readonly LlmDiscoveredModel[] | undefined>(undefined)
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set())
  const [busy, setBusy] = useState<'refresh' | 'save' | 'remove' | undefined>(undefined)
  const [status, setStatus] = useState<Status>(undefined)

  const reload = useCallback(async (resetForm: boolean): Promise<SettingsSnapshot | undefined> => {
    try {
      const next = await operations.describe()
      setSnapshot(next)
      if (resetForm) {
        setForm(formFromSnapshot(next, t('defaultDisplayName')))
        setPicked(new Set(next.piAi?.route?.models.map(model => model.id) ?? []))
      }
      return next
    } catch (error) {
      setStatus({ tone: 'error', text: t('loadFailed', { message: error instanceof Error ? error.message : String(error) }) })
      return undefined
    }
  }, [operations, t])

  useEffect(() => { void reload(true) }, [reload])

  if (form === undefined || snapshot === undefined) {
    return h('div', { className: 'dsh-localai' },
      h('p', { className: status?.tone === 'error' ? 'dsh-localai-error' : 'dsh-localai-muted' }, status?.text ?? t('loading')))
  }

  const route = snapshot.piAi?.route
  const hostReady = snapshot.piAi !== undefined && snapshot.self !== undefined
  const disabled = busy !== undefined || !snapshot.writable || !hostReady
  const update = (patch: Partial<FormState>): void => {
    setForm({ ...form, ...patch })
    setStatus(undefined)
  }

  /** Make the running gateway match the form before the Host dials through it. */
  const ensureGateway = async (current: SettingsSnapshot, wanted: TailscaleSettings | undefined): Promise<'ok' | 'conflict' | string> => {
    const self = current.self
    /* v8 ignore next -- callers check hostReady first */
    if (self === undefined) return t('hostMissing')
    const target = wanted ?? { ...self.tailscale, enabled: false }
    if (sameTailscale(self.tailscale, target)) return 'ok'
    const written = await operations.write(LOCAL_AI_ENTRY, [{ op: 'set', path: ['tailscale'], value: { ...target } }], self.revision)
    if (written.kind === 'conflict') return 'conflict'
    if (written.kind === 'refused') return written.message
    setSnapshot({ ...current, self: { revision: written.revision, tailscale: target } })
    return 'ok'
  }

  const discover = async (baseURL: string, viaGateway: boolean): Promise<Awaited<ReturnType<LocalAiOperations['discover']>>> => {
    const request = {
      baseURL,
      ...(key.trim().length > 0 ? { apiKey: key.trim() } : {}),
      // A saved route lends its stored credential to discovery.
      ...(route !== undefined && key.trim().length === 0 ? { provider: LOCAL_AI_PROVIDER } : {}),
    }
    // The gateway restarts asynchronously after its settings change.
    for (let attempt = 0; ; attempt++) {
      const answer = await operations.discover(request)
      if (answer.kind === 'found' || !viaGateway || attempt >= 5) return answer
      await delay(300)
    }
  }

  const refresh = async (): Promise<void> => {
    const target = resolveTarget(form)
    if (target.kind === 'invalid') { setStatus({ tone: 'error', text: t(target.reason) }); return }
    setBusy('refresh')
    setStatus(undefined)
    try {
      if (target.tailscale !== undefined) {
        const gateway = await ensureGateway(snapshot, target.tailscale)
        if (gateway === 'conflict') { await reload(false); setStatus({ tone: 'error', text: t('conflict') }); return }
        if (gateway !== 'ok') { setStatus({ tone: 'error', text: gateway }); return }
      }
      const answer = await discover(target.baseURL, target.tailscale !== undefined)
      if (answer.kind === 'refused') { setStatus({ tone: 'error', text: answer.message }); return }
      if (answer.models.length === 0) { setStatus({ tone: 'error', text: t('fetchEmpty') }); setCandidates([]); return }
      setCandidates(answer.models)
      const saved = new Set(route?.models.map(model => model.id) ?? [])
      const keep = answer.models.filter(model => saved.has(model.id))
      setPicked(new Set((keep.length > 0 ? keep : answer.models).map(model => model.id)))
    } finally {
      setBusy(undefined)
    }
  }

  const save = async (): Promise<void> => {
    const target = resolveTarget(form)
    if (target.kind === 'invalid') { setStatus({ tone: 'error', text: t(target.reason) }); return }
    const models: LocalAiModel[] = candidates === undefined
      ? (route?.models ?? []).filter(model => picked.has(model.id))
      : candidates.filter(model => picked.has(model.id)).map(modelFromDiscovery)
    if (models.length === 0) { setStatus({ tone: 'error', text: t('noModels') }); return }
    /* v8 ignore next -- the button is disabled until both namespaces exist */
    if (snapshot.piAi === undefined) return
    setBusy('save')
    setStatus(undefined)
    try {
      const gateway = await ensureGateway(snapshot, target.tailscale)
      if (gateway === 'conflict') { await reload(false); setStatus({ tone: 'error', text: t('conflict') }); return }
      if (gateway !== 'ok') { setStatus({ tone: 'error', text: gateway }); return }
      const displayName = form.displayName.trim().length > 0 ? form.displayName.trim() : t('defaultDisplayName')
      const value = { ...route?.raw, ...providerProfile({ displayName, baseURL: target.baseURL, models }) }
      const written = await operations.write(PI_AI_NAMESPACE, [{ op: 'set', path: ['providers', LOCAL_AI_PROVIDER], value: value as never }], snapshot.piAi.revision)
      if (written.kind === 'conflict') { await reload(false); setStatus({ tone: 'error', text: t('conflict') }); return }
      if (written.kind === 'refused') { setStatus({ tone: 'error', text: written.message }); return }
      const typedKey = key.trim()
      if (typedKey.length > 0 || !snapshot.keyConfigured) {
        const failure = await operations.storeKey(typedKey.length > 0 ? typedKey : NO_KEY_PLACEHOLDER)
        if (failure !== undefined) { setStatus({ tone: 'error', text: failure }); return }
      }
      setKey('')
      await reload(true)
      setCandidates(undefined)
      setStatus({ tone: 'ok', text: t('saved', { count: models.length }) })
    } finally {
      setBusy(undefined)
    }
  }

  const remove = async (): Promise<void> => {
    /* v8 ignore next -- the button renders only for a saved route */
    if (snapshot.piAi === undefined) return
    setBusy('remove')
    setStatus(undefined)
    try {
      const written = await operations.write(PI_AI_NAMESPACE, [{ op: 'unset', path: ['providers', LOCAL_AI_PROVIDER] }], snapshot.piAi.revision)
      if (written.kind === 'conflict') { await reload(false); setStatus({ tone: 'error', text: t('conflict') }); return }
      if (written.kind === 'refused') { setStatus({ tone: 'error', text: written.message }); return }
      const gateway = await ensureGateway(snapshot, undefined)
      if (gateway !== 'ok' && gateway !== 'conflict') { setStatus({ tone: 'error', text: gateway }); return }
      const failure = await operations.removeKey()
      if (failure !== undefined) { setStatus({ tone: 'error', text: failure }); return }
      await reload(true)
      setCandidates(undefined)
      setStatus({ tone: 'ok', text: t('removed') })
    } finally {
      setBusy(undefined)
    }
  }

  const listed: readonly { readonly id: string, readonly name?: string, readonly contextWindow?: number }[] = candidates ?? route?.models ?? []
  const children: ReactNode[] = [
    h('p', { key: 'intro', className: 'dsh-localai-muted' }, t('intro')),
  ]

  children.push(h('p', { key: 'current', className: 'dsh-localai-muted' }, route === undefined
    ? t('notConfigured')
    : t('current', {
      name: route.displayName,
      count: route.models.length,
      route: fromGatewayBaseURL(route.baseURL) === undefined ? t('currentDirect') : t('currentTailscale'),
    })))

  if (!snapshot.writable) children.push(h('p', { key: 'readonly', className: 'dsh-localai-error' }, t('readOnly')))
  else if (!hostReady) children.push(h('p', { key: 'host', className: 'dsh-localai-error' }, t('hostMissing')))

  children.push(h('div', { key: 'mode', className: 'dsh-localai-field' },
    h('span', { className: 'dsh-localai-label' }, t('mode')),
    h('div', { className: 'dsh-localai-segment', role: 'group', 'aria-label': t('mode') },
      (['direct', 'tailscale'] as const).map(mode => h('button', {
        key: mode,
        type: 'button',
        'aria-pressed': form.mode === mode,
        disabled: busy !== undefined,
        onClick: () => { update({ mode }) },
      }, mode === 'direct' ? t('modeDirect') : t('modeTailscale')))),
    form.mode === 'tailscale' ? h('p', { className: 'dsh-localai-muted' }, t('tailscaleHelp')) : null))

  children.push(field(t('endpoint'), h('input', {
    className: 'dsh-localai-input',
    type: 'text',
    inputMode: 'url',
    spellCheck: false,
    autoComplete: 'off',
    value: form.endpoint,
    placeholder: form.mode === 'tailscale' ? t('endpointPlaceholderTailscale') : t('endpointPlaceholder'),
    disabled: busy !== undefined,
    onChange: (event: { target: { value: string } }) => { update({ endpoint: event.target.value }) },
  }), 'endpoint'))

  if (form.mode === 'tailscale') {
    children.push(h('div', { key: 'tailscale', className: 'dsh-localai-row' },
      field(t('proxy'), h('input', {
        className: 'dsh-localai-input',
        type: 'text',
        spellCheck: false,
        autoComplete: 'off',
        value: form.proxy,
        placeholder: DEFAULT_TAILSCALE_PROXY,
        disabled: busy !== undefined,
        onChange: (event: { target: { value: string } }) => { update({ proxy: event.target.value }) },
      }), 'proxy'),
      field(t('gatewayPort'), h('input', {
        className: 'dsh-localai-input',
        type: 'number',
        min: 1024,
        max: 65535,
        value: form.port,
        disabled: busy !== undefined,
        onChange: (event: { target: { value: string } }) => { update({ port: event.target.value }) },
      }), 'port')))
  }

  children.push(h('div', { key: 'identity', className: 'dsh-localai-row' },
    field(t('displayName'), h('input', {
      className: 'dsh-localai-input',
      type: 'text',
      value: form.displayName,
      placeholder: t('defaultDisplayName'),
      disabled: busy !== undefined,
      onChange: (event: { target: { value: string } }) => { update({ displayName: event.target.value }) },
    }), 'name'),
    field(t('apiKey'), h('span', { className: 'dsh-localai-keywrap' },
      h('input', {
        className: 'dsh-localai-input',
        type: showKey ? 'text' : 'password',
        autoComplete: 'new-password',
        spellCheck: false,
        value: key,
        placeholder: snapshot.keyConfigured ? t('apiKeySaved') : t('apiKeyPlaceholder'),
        disabled: busy !== undefined,
        onChange: (event: { target: { value: string } }) => { setKey(event.target.value); setShowKey(false) },
      }),
      key.length > 0
        ? h('button', { type: 'button', className: 'dsh-localai-button', onClick: () => { setShowKey(!showKey) } }, showKey ? t('hideKey') : t('showKey'))
        : null), 'key')))

  children.push(h('div', { key: 'refresh', className: 'dsh-localai-actions' },
    h('button', {
      type: 'button',
      className: 'dsh-localai-button',
      disabled,
      onClick: () => { void refresh() },
    }, busy === 'refresh' ? t('refreshing') : t('refresh'))))

  if (listed.length > 0) {
    children.push(h('div', { key: 'models', className: 'dsh-localai-field' },
      h('div', { className: 'dsh-localai-models-head' },
        h('span', { className: 'dsh-localai-label' }, `${t('models')} (${String(picked.size)}/${String(listed.length)})`),
        h('span', { className: 'dsh-localai-actions' },
          h('button', { type: 'button', className: 'dsh-localai-button', disabled: busy !== undefined, onClick: () => { setPicked(new Set(listed.map(model => model.id))) } }, t('selectAll')),
          h('button', { type: 'button', className: 'dsh-localai-button', disabled: busy !== undefined, onClick: () => { setPicked(new Set()) } }, t('deselectAll')))),
      h('div', { className: 'dsh-localai-models' }, listed.map(model => h('label', {
        key: model.id,
        className: 'dsh-localai-model',
        title: model.name ?? model.id,
      },
      h('input', {
        type: 'checkbox',
        checked: picked.has(model.id),
        disabled: busy !== undefined,
        onChange: () => {
          const next = new Set(picked)
          if (!next.delete(model.id)) next.add(model.id)
          setPicked(next)
        },
      }),
      h('code', null, model.id),
      model.contextWindow === undefined ? null : h('span', { className: 'dsh-localai-muted' }, t('contextWindow', { count: model.contextWindow.toLocaleString() })))))))
  }

  children.push(h('div', { key: 'save', className: 'dsh-localai-actions' },
    h('button', {
      type: 'button',
      className: 'dsh-localai-button',
      'data-primary': 'true',
      disabled: disabled || picked.size === 0,
      onClick: () => { void save() },
    }, busy === 'save' ? t('saving') : t('save')),
    route === undefined ? null : h('button', {
      type: 'button',
      className: 'dsh-localai-button',
      'data-danger': 'true',
      disabled,
      onClick: () => { void remove() },
    }, busy === 'remove' ? t('removing') : t('remove'))))

  if (status !== undefined) {
    children.push(h('p', {
      key: 'status',
      role: status.tone === 'error' ? 'alert' : 'status',
      className: status.tone === 'error' ? 'dsh-localai-error' : status.tone === 'ok' ? 'dsh-localai-ok' : 'dsh-localai-muted',
    }, status.text))
  }

  return h('div', { className: 'dsh-localai' }, children)
}

function installStyle(): () => void {
  if (typeof document === 'undefined') return () => undefined
  if (document.getElementById(LOCAL_AI_STYLE_ID) !== null) return () => undefined
  const style = document.createElement('style')
  style.id = LOCAL_AI_STYLE_ID
  style.textContent = styleText
  document.head.append(style)
  return () => style.remove()
}

/**
 * Register into the subscription hub's tab list when it is loaded, and fall
 * back to a standalone Settings section while it is not, so the page is
 * reachable either way and never shown twice.
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind(LOCAL_AI_LOCALE_NAMESPACE) as Translate
  const operations = createLocalAiOperations(ctx.remote)
  const options = {
    id: 'local-ai',
    order: 30,
    label: () => t('nav'),
    locale: LOCAL_AI_LOCALE_NAMESPACE,
    inject: () => ({ operations }),
  }
  const Page: SlotComponent<any> = (props: { operations: LocalAiOperations, t: Translate }) => h(LocalAiPage, { operations: props.operations, t: props.t })
  const StandalonePage: SlotComponent<any> = (props: { operations: LocalAiOperations, t: Translate }) => h('div', null,
    h('h2', { style: { margin: 0, fontSize: 18, fontWeight: 600 } }, props.t('title')),
    h(LocalAiPage, { operations: props.operations, t: props.t }))

  ctx.effect(() => ctx.locale.register(LOCAL_AI_LOCALE_NAMESPACE, dictionaries), 'local-ai: dictionaries')
  ctx.effect(installStyle, 'local-ai: style')

  let hubLive = false
  let sectionLive = false
  let standalone: (() => void) | undefined
  const dropStandalone = (): void => { const dispose = standalone; standalone = undefined; dispose?.() }
  const syncStandalone = (): void => {
    if (sectionLive && !hubLive && standalone === undefined) {
      standalone = ctx.slots.register({ ...options, name: SETTINGS_SECTION_SLOT } as never, StandalonePage)
    } else if ((hubLive || !sectionLive) && standalone !== undefined) {
      dropStandalone()
    }
  }
  ctx.slots.inject(SUBSCRIPTIONS_PAGE_SLOT, () => {
    hubLive = true
    syncStandalone()
    const dispose = ctx.slots.register({ ...options, name: SUBSCRIPTIONS_PAGE_SLOT } as never, Page)
    return () => {
      dispose()
      hubLive = false
      syncStandalone()
    }
  })
  ctx.slots.inject(SETTINGS_SECTION_SLOT, () => {
    sectionLive = true
    syncStandalone()
    return () => {
      sectionLive = false
      dropStandalone()
    }
  })
  ctx.effect(() => dropStandalone, 'local-ai: standalone section')
}
