import {
  createElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
} from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { InsightConfigV1, InsightModelSelection } from './insight-contract.js'
import type {
  WebEffortChoice,
  WebModelCatalog,
  WebModelCatalogApi,
  WebModelChoice,
} from './model-catalog.js'
import { insightGeminiReadiness } from './flow-readiness.js'
import type { WebPreferences, WebPreferencesSaveInput } from './preferences.js'

export interface PreferencesClientApi {
  read(): Promise<WebPreferences>
  save(input: WebPreferencesSaveInput): Promise<WebPreferences>
}
export interface PreferencesPanelApis {
  readonly api?: PreferencesClientApi
  readonly modelCatalog?: WebModelCatalogApi
}

export interface PreferencesWire {
  read(): Promise<RemoteResult<WebPreferences>>
  save(input: WebPreferencesSaveInput): Promise<RemoteResult<WebPreferences>>
}

export function unwrapPreferencesRemote<T>(result: RemoteResult<T>): T {
  if (result.ok) return result.value
  throw result.error
}

export function createPreferencesApi(wire: PreferencesWire): PreferencesClientApi {
  return {
    read: async () => unwrapPreferencesRemote(await wire.read()),
    save: async input => unwrapPreferencesRemote(await wire.save(input)),
  }
}

const panelStyle: CSSProperties = {
  display: 'grid',
  gap: 22,
  minWidth: 0,
  width: '100%',
  maxWidth: 920,
  margin: '0 auto',
  boxSizing: 'border-box',
  padding: '28px clamp(16px, 4vw, 42px) 32px',
  color: 'var(--dsw-alias-label-primary)',
  background: 'var(--dsw-alias-bg-base)',
  fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
}

const heroStyle: CSSProperties = {
  display: 'grid',
  gap: 8,
  minWidth: 0,
}

const eyebrowStyle: CSSProperties = {
  margin: 0,
  color: '#b9a8ff',
  fontSize: '0.72rem',
  fontWeight: 700,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
}

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 'clamp(1.45rem, 3vw, 2rem)',
  lineHeight: 1.1,
  letterSpacing: '-0.025em',
  overflowWrap: 'anywhere',
}

const leadStyle: CSSProperties = {
  margin: 0,
  maxWidth: 680,
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: '0.95rem',
  lineHeight: 1.55,
  overflowWrap: 'anywhere',
}

const surfaceStyle: CSSProperties = {
  display: 'grid',
  gap: 18,
  minWidth: 0,
  padding: '20px clamp(16px, 3vw, 26px)',
  border: '1px solid var(--dsw-alias-settings-card-stroke)',
  borderRadius: 16,
  background: 'var(--dsw-alias-settings-card-fill)',
  boxShadow: '0 16px 42px rgba(0, 0, 0, 0.14)',
}

const surfaceHeaderStyle: CSSProperties = {
  display: 'grid',
  gap: 5,
  minWidth: 0,
}

const headingStyle: CSSProperties = {
  margin: 0,
  fontSize: '1.05rem',
  lineHeight: 1.25,
  letterSpacing: '-0.01em',
  overflowWrap: 'anywhere',
}

const fieldGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: 14,
  minWidth: 0,
}

const fieldStyle: CSSProperties = { display: 'grid', gap: 7, minWidth: 0 }
const labelStyle: CSSProperties = { fontSize: '0.82rem', fontWeight: 650, overflowWrap: 'anywhere' }

const inputStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  minWidth: 0,
  maxWidth: '100%',
  padding: '10px 11px',
  border: '1px solid var(--dsw-alias-settings-card-stroke)',
  borderRadius: 9,
  background: 'var(--dsw-alias-bg-module-platform)',
  color: 'inherit',
  font: 'inherit',
  lineHeight: 1.35,
  outlineColor: '#a78bfa',
}

const actionRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 9,
  alignItems: 'center',
  minWidth: 0,
}

const buttonStyle: CSSProperties = {
  minHeight: 36,
  maxWidth: '100%',
  padding: '8px 13px',
  border: '1px solid var(--dsw-alias-settings-card-stroke)',
  borderRadius: 9,
  background: 'var(--dsw-alias-bg-module-platform)',
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: '0.84rem',
  fontWeight: 650,
  overflowWrap: 'anywhere',
}

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  borderColor: '#8b5cf6',
  background: '#7c3aed',
  color: '#fff',
  boxShadow: '0 7px 18px rgba(124, 58, 237, 0.25)',
}

const secondaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  color: '#d6ccff',
  borderColor: '#5c4c96',
}

const mutedStyle: CSSProperties = {
  margin: 0,
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: '0.82rem',
  lineHeight: 1.5,
  overflowWrap: 'anywhere',
}

const noticeStyle: CSSProperties = {
  margin: 0,
  padding: '11px 13px',
  borderRadius: 10,
  border: '1px solid var(--dsw-alias-settings-card-stroke)',
  background: 'var(--dsw-alias-bg-module-platform)',
  fontSize: '0.84rem',
  lineHeight: 1.45,
  overflowWrap: 'anywhere',
}

const tabListStyle: CSSProperties = {
  display: 'flex',
  gap: 5,
  width: 'fit-content',
  maxWidth: '100%',
  padding: 4,
  border: '1px solid var(--dsw-alias-settings-card-stroke)',
  borderRadius: 12,
  background: 'var(--dsw-alias-bg-module-platform)',
}

const tabStyle: CSSProperties = {
  minHeight: 36,
  padding: '8px 15px',
  border: 0,
  borderRadius: 9,
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: '0.86rem',
  fontWeight: 700,
}

const activeTabStyle: CSSProperties = {
  ...tabStyle,
  background: '#6d4bd8',
  color: '#fff',
  boxShadow: '0 4px 12px rgba(109, 75, 216, 0.28)',
}

const detailStyle: CSSProperties = {
  minWidth: 0,
  borderTop: '1px solid var(--dsw-alias-settings-card-stroke)',
}

const detailSummaryStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  minWidth: 0,
  padding: '14px 0',
  cursor: 'pointer',
  listStyle: 'none',
  overflowWrap: 'anywhere',
}

const stageListStyle: CSSProperties = {
  display: 'grid',
  minWidth: 0,
}

const stageNumberStyle: CSSProperties = {
  display: 'inline-grid',
  placeItems: 'center',
  flex: '0 0 auto',
  width: 27,
  height: 27,
  borderRadius: '50%',
  background: '#33245f',
  color: '#d9ceff',
  fontSize: '0.75rem',
  fontWeight: 800,
}

const summaryTextStyle: CSSProperties = {
  display: 'grid',
  gap: 3,
  minWidth: 0,
}

const footerStyle: CSSProperties = {
  position: 'sticky',
  bottom: 0,
  zIndex: 2,
  display: 'flex',
  flexWrap: 'wrap',
  gap: 10,
  alignItems: 'center',
  justifyContent: 'space-between',
  minWidth: 0,
  padding: '13px 0 4px',
  borderTop: '1px solid var(--dsw-alias-settings-card-stroke)',
  background: 'var(--dsw-alias-bg-base)',
}

type ConfigStageKey = 'clarification' | 'plan' | 'research' | 'fallbackResearch' | 'critique' | 'polish' | 'fallbackPolish'

const STAGES: readonly { readonly id: ConfigStageKey; readonly label: string; readonly mode: boolean }[] = [
  { id: 'clarification', label: '澄清问题', mode: false },
  { id: 'plan', label: '研究计划', mode: true },
  { id: 'research', label: '深度研究', mode: true },
  { id: 'critique', label: 'ChatGPT 核验', mode: true },
  { id: 'polish', label: '研究润色', mode: true },
  { id: 'fallbackResearch', label: '回落研究', mode: true },
  { id: 'fallbackPolish', label: '回落润色', mode: true },
]

function errorText(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error)
  return value.trim().replace(/^[A-Z][A-Z0-9_/-]+:\s*/, '') || '设置操作未完成。'
}

function clonePreferences(value: WebPreferences): WebPreferences {
  return JSON.parse(JSON.stringify(value)) as WebPreferences
}

function cloneInsight(value: InsightConfigV1): InsightConfigV1 {
  return JSON.parse(JSON.stringify(value)) as InsightConfigV1
}

function updateRequested(
  value: WebPreferences,
  stage: ConfigStageKey,
  key: keyof InsightModelSelection,
  nextValue: string,
): WebPreferences {
  const next = clonePreferences(value)
  const config = cloneInsight(next.insight)
  const requested = (config as unknown as Record<ConfigStageKey, { requested: Record<string, unknown> }>)[stage].requested
  const normalized = nextValue.trim()
  if (normalized.length === 0) delete requested[key]
  else requested[key] = normalized
  return { ...next, insight: config }
}

function updateTemplate(value: WebPreferences, stage: ConfigStageKey | 'delivery', text: string): WebPreferences {
  const next = clonePreferences(value)
  const config = cloneInsight(next.insight)
  const target = (config as unknown as Record<ConfigStageKey | 'delivery', { template: { text: string } }>)[stage]
  target.template.text = text
  return { ...next, insight: config }
}

function updateNumber(value: WebPreferences, field: 'maxRounds' | 'maxQuestionsPerRound' | 'researchWaitMs', text: string): WebPreferences {
  const next = clonePreferences(value)
  const config = cloneInsight(next.insight) as unknown as Record<string, unknown>
  const numeric = Number(text)
  if (field === 'researchWaitMs') config[field] = numeric
  else (config.clarification as Record<string, unknown>)[field] = numeric
  return { ...next, insight: config as unknown as InsightConfigV1 }
}

function providerLabel(provider: InsightModelSelection['provider']): string {
  switch (provider) {
    case 'codex': return 'Codex'
    case 'gemini': return 'Gemini'
    case 'chatgpt': return 'ChatGPT 网页'
  }
}

function stageRequested(config: InsightConfigV1, stage: ConfigStageKey): InsightModelSelection {
  return (config as unknown as Record<ConfigStageKey, { requested: InsightModelSelection }>)[stage].requested
}

function stageTemplate(config: InsightConfigV1, stage: ConfigStageKey): string {
  return (config as unknown as Record<ConfigStageKey, { template: { text: string } }>)[stage].template.text
}

function summaryValue(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim() ?? ''
  return trimmed.length === 0 ? fallback : trimmed
}

function stageSummary(requested: InsightModelSelection): string {
  const selections = [requested.modelLabel, requested.effortLabel, requested.modeLabel]
    .map(value => value?.trim() ?? '')
    .filter(value => value.length > 0)
  return `${providerLabel(requested.provider)} · ${selections.length === 0 ? '未填写精确选择' : selections.join(' · ')}`
}

function InputField(props: {
  readonly id: string
  readonly label: string
  readonly value: string
  readonly onChange: (event: ChangeEvent<HTMLInputElement>) => void
  readonly type?: 'text' | 'number'
  readonly placeholder?: string
}): ReactElement {
  return createElement('div', { style: fieldStyle }, [
    createElement('label', { key: 'label', htmlFor: props.id, style: labelStyle }, props.label),
    createElement('input', {
      key: 'input',
      id: props.id,
      type: props.type ?? 'text',
      value: props.value,
      placeholder: props.placeholder,
      onChange: props.onChange,
      style: inputStyle,
    }),
  ])
}

function TemplateField(props: { readonly id: string; readonly label: string; readonly value: string; readonly onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void }): ReactElement {
  return createElement('div', { style: fieldStyle }, [
    createElement('label', { key: 'label', htmlFor: props.id, style: labelStyle }, props.label),
    createElement('textarea', { key: 'input', id: props.id, value: props.value, onChange: props.onChange, rows: 5, style: { ...inputStyle, resize: 'vertical' } }),
  ])
}

/** Return only choices the target Ego Lite page reported as enabled. */
export function availableCatalogModels(catalog: WebModelCatalog | undefined): readonly WebModelChoice[] {
  return catalog?.models.filter(choice => choice.available) ?? []
}

/** Effort choices stay scoped to the model used for the explicit observation. */
export function availableCatalogEfforts(catalog: WebModelCatalog | undefined, modelLabel: string): readonly WebEffortChoice[] {
  if (catalog === undefined || modelLabel !== catalog.effortModelLabel) return []
  return catalog.efforts.filter(choice => choice.available)
}

/** ChatGPT Insight stages share the Ego Lite catalogue; Codex/Gemini do not. */
export function shouldOfferCatalogChoices(selection: InsightModelSelection): boolean {
  return selection.provider === 'chatgpt'
}

export function catalogValueIsUnmatched(value: string, choices: readonly { readonly label: string }[]): boolean {
  return value.length > 0 && !choices.some(choice => choice.label === value)
}

export function formatCatalogObservedAt(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZoneName: 'short',
  }).format(date)
}

function CatalogChoiceField(props: {
  readonly id: string
  readonly label: string
  readonly value: string
  readonly choices: readonly { readonly label: string }[]
  readonly catalogObserved?: boolean
  readonly allowEmpty?: boolean
  readonly emptyLabel?: string
  readonly onChange: (value: string) => void
}): ReactElement | null {
  if (props.choices.length === 0 && props.allowEmpty !== true) {
    if (props.catalogObserved !== true || props.value.length === 0) return null
    return createElement('p', { style: mutedStyle }, '当前保存的精确标签在这次目录中没有可用项，仍会保留；不会自动替换。')
  }
  const unmatched = catalogValueIsUnmatched(props.value, props.choices)
  const options = [
    props.allowEmpty === true ? createElement('option', { key: 'empty', value: '' }, props.emptyLabel ?? '跟随目标浏览器当前选择') : null,
    unmatched ? createElement('option', { key: 'unmatched', value: props.value }, `当前保存：${props.value}（目录未匹配）`) : null,
    ...props.choices.map(choice => createElement('option', { key: choice.label, value: choice.label }, choice.label)),
  ]
  return createElement('div', { style: fieldStyle }, [
    createElement('label', { key: 'label', htmlFor: props.id, style: labelStyle }, props.label),
    createElement('select', {
      key: 'select',
      id: props.id,
      value: props.value,
      onChange: (event: ChangeEvent<HTMLSelectElement>) => props.onChange(event.target.value),
      style: inputStyle,
    }, options),
    unmatched
      ? createElement('p', { key: 'note', style: { ...mutedStyle, color: '#f5c7a9' } }, '保留当前精确标签；这次目录没有匹配项，不会自动替换。')
      : null,
  ])
}

function CatalogTargetSummary(props: {
  readonly catalog: WebModelCatalog | undefined
  readonly onRefresh: () => void
  readonly refreshing: boolean
}): ReactElement {
  const selected = props.catalog?.selected
  const selectedEffort = selected?.effortLabel ?? selected?.effortId ?? '未观测到思考档'
  return createElement('div', { style: { display: 'grid', gap: 14, minWidth: 0 } }, [
    createElement('div', { key: 'summary', style: { display: 'grid', gap: 5, minWidth: 0 } }, [
      createElement('p', { key: 'eyebrow', style: eyebrowStyle }, '插件目标浏览器'),
      createElement('div', { key: 'line', style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline', minWidth: 0 } }, [
        createElement('strong', { key: 'browser', style: { fontSize: '1rem' } }, 'Ego Lite'),
        createElement('span', { key: 'current', style: mutedStyle }, props.catalog === undefined
          ? '尚未读取缓存目录'
          : `当前选择：${summaryValue(selected?.modelLabel, '未观测')} · ${selectedEffort}`),
      ]),
      props.catalog === undefined
        ? createElement('p', { key: 'hint', style: mutedStyle }, '目录读取只使用缓存；点击刷新后才会检查目标浏览器。')
        : createElement('p', { key: 'observed', style: mutedStyle }, '可用模型来自最近一次显式观测。'),
    ]),
    createElement('div', { key: 'actions', style: actionRowStyle }, [
      createElement('button', { key: 'refresh', type: 'button', disabled: props.refreshing, onClick: props.onRefresh, style: secondaryButtonStyle }, props.refreshing ? '正在刷新…' : '刷新可用模型'),
    ]),
  ])
}

function stageFields(
  current: WebPreferences,
  stage: ConfigStageKey,
  requested: InsightModelSelection,
  catalog: WebModelCatalog | undefined,
  fieldId: string,
  update: (next: WebPreferences) => void,
): ReactElement[] {
  const useCatalog = shouldOfferCatalogChoices(requested)
  const efforts = useCatalog ? availableCatalogEfforts(catalog, requested.modelLabel) : []
  const fields: ReactElement[] = []
  if (stage === 'clarification') {
    fields.push(createElement(InputField, { key: 'query', id: `${fieldId}-clarification-query`, label: '精确查询标识（可选）', value: requested.modelId ?? '', onChange: event => update(updateRequested(current, stage, 'modelId', event.target.value)), placeholder: '留空使用模型标签' }))
  }
  if (useCatalog) {
    fields.push(createElement(CatalogChoiceField, { key: 'model-choice', id: `${fieldId}-${stage}-model-choice`, label: '已观测模型', value: requested.modelLabel, choices: availableCatalogModels(catalog), catalogObserved: catalog !== undefined, onChange: value => update(updateRequested(current, stage, 'modelLabel', value)) }))
  }
  fields.push(createElement(InputField, { key: 'model', id: `${fieldId}-${stage}-model`, label: '模型标签', value: requested.modelLabel, onChange: event => update(updateRequested(current, stage, 'modelLabel', event.target.value)) }))
  if (useCatalog) {
    fields.push(createElement(CatalogChoiceField, { key: 'effort-choice', id: `${fieldId}-${stage}-effort-choice`, label: `已观测思考档${catalog === undefined ? '' : ` · ${catalog.effortModelLabel}`}`, value: requested.effortLabel ?? '', choices: efforts, catalogObserved: catalog !== undefined, allowEmpty: true, onChange: value => update(updateRequested(current, stage, 'effortLabel', value)) }))
  }
  fields.push(createElement(InputField, { key: 'effort', id: `${fieldId}-${stage}-effort`, label: '思考档标签', value: requested.effortLabel ?? '', onChange: event => update(updateRequested(current, stage, 'effortLabel', event.target.value)), placeholder: '可留空' }))
  if (stage !== 'clarification') {
    fields.push(createElement(InputField, { key: 'mode', id: `${fieldId}-${stage}-mode`, label: '模式标签', value: requested.modeLabel ?? '', onChange: event => update(updateRequested(current, stage, 'modeLabel', event.target.value)), placeholder: '可留空' }))
  } else {
    fields.push(createElement(InputField, { key: 'rounds', id: `${fieldId}-clarification-rounds`, label: '最多轮数', type: 'number', value: String(current.insight.clarification.maxRounds), onChange: event => update(updateNumber(current, 'maxRounds', event.target.value)) }))
    fields.push(createElement(InputField, { key: 'questions', id: `${fieldId}-clarification-questions`, label: '每轮最多问题数', type: 'number', value: String(current.insight.clarification.maxQuestionsPerRound), onChange: event => update(updateNumber(current, 'maxQuestionsPerRound', event.target.value)) }))
  }
  fields.push(createElement(TemplateField, { key: 'template', id: `${fieldId}-${stage}-template`, label: '提示模板', value: stageTemplate(current.insight, stage), onChange: event => update(updateTemplate(current, stage, event.target.value)) }))
  return fields
}

function GeminiReadinessSummary(props: { readonly preferences: WebPreferences }): ReactElement {
  const readiness = insightGeminiReadiness(props.preferences.insight, props.preferences.geminiSemantics)
  const missing = readiness.requirements.filter(requirement => !requirement.configured)
  return createElement('section', {
    'aria-label': '完整洞察流程就绪状态',
    style: {
      display: 'grid',
      gap: 10,
      minWidth: 0,
      padding: '14px 0 4px',
      borderTop: '1px solid var(--dsw-alias-settings-card-stroke)',
      borderBottom: '1px solid var(--dsw-alias-settings-card-stroke)',
    },
  }, [
    createElement('div', { key: 'heading', style: { display: 'grid', gap: 4, minWidth: 0 } }, [
      createElement('strong', { key: 'title', style: { overflowWrap: 'anywhere' } }, readiness.configurationComplete ? '完整洞察流程可进入网页前置校验' : '完整洞察流程当前不会启动'),
      createElement('p', { key: 'explanation', role: 'status', style: mutedStyle }, readiness.configurationComplete
        ? '必要语义路径已具备。实际执行仍会逐项确认控件唯一、可见、启用并完成回读；此状态不表示 Gemini 已可用、研究已启动或流程已验收。'
        : '缺少项会在任何前序模型调用前拒绝；不会改用普通网页，也不会自动重试。'),
      createElement('p', { key: 'observed-adapter', style: mutedStyle }, '已内置无模型页面观察到的 4 Argon 选择、Deep Research 切换、发送就绪、原问题可见回执、计划标志、报告完成态及 high→高回读，并记录开始研究定位。开始研究每次仍须唯一、可见且启用，否则停止。'),
    ]),
    createElement('div', { key: 'targets', style: { display: 'grid', gap: 5, minWidth: 0 } }, readiness.targets.map(target => createElement('p', { key: target.id, style: mutedStyle }, target.configurationComplete
      ? `${target.label}：配置已齐全，仍待实际页面唯一性校验。`
      : `${target.label}：未配置 ${target.missing.map(item => readiness.requirements.find(requirement => requirement.id === item)?.label ?? item).join('、')}。`))),
    createElement('ul', { key: 'requirements', style: { display: 'grid', gap: 5, margin: 0, paddingInlineStart: 18, minWidth: 0 } }, readiness.requirements.map(requirement => createElement('li', { key: requirement.id, style: mutedStyle }, requirement.source === 'observed-adapter'
      ? `${requirement.label}：已由内置无模型观察路径覆盖；执行时仍须进行唯一可见性回读。`
      : requirement.source === 'preferences'
        ? `${requirement.label}：已配置；此界面不把配置视为实际网页验收。`
        : `${requirement.label}：未配置，尚未验收。`))),
    missing.length === 0
      ? null
      : createElement('p', { key: 'guide', style: mutedStyle }, '请只填入已通过无模型页面观察确认的语义选择器或标志；不要根据猜测填写 CSS 选择器。'),
  ])
}

export function PreferencesPanel({ api, modelCatalog }: PreferencesPanelApis): ReactElement {
  const fieldId = useId()
  const [preferences, setPreferences] = useState<WebPreferences | undefined>()
  const [catalog, setCatalog] = useState<WebModelCatalog | undefined>()
  const [catalogTargetModel, setCatalogTargetModel] = useState('')
  const [catalogRefreshing, setCatalogRefreshing] = useState(false)
  const [advancedJson, setAdvancedJson] = useState('')
  const [advancedDirty, setAdvancedDirty] = useState(false)
  const [geminiJson, setGeminiJson] = useState('{}')
  const [geminiDirty, setGeminiDirty] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [activeTab, setActiveTab] = useState<'web' | 'insight'>('web')
  const [notice, setNotice] = useState<{ readonly tone: 'info' | 'error'; readonly message: string } | undefined>()
  const readLock = useRef(false)

  const read = useCallback(async (): Promise<void> => {
    if (api === undefined || readLock.current) return
    readLock.current = true
    setLoading(true)
    try {
      const value = await api.read()
      setPreferences(value)
      setAdvancedJson(JSON.stringify(value.insight, null, 2))
      setAdvancedDirty(false)
      setGeminiJson(JSON.stringify(value.geminiSemantics ?? {}, null, 2))
      setGeminiDirty(false)
      setNotice(undefined)
    } catch (error) {
      setNotice({ tone: 'error', message: `无法读取设置：${errorText(error)}` })
    } finally {
      readLock.current = false
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    void read()
  }, [read])

  // Reading a cached snapshot is safe during mount. Refresh is only explicit.
  useEffect(() => {
    if (modelCatalog === undefined) {
      setCatalog(undefined)
      return
    }
    let active = true
    void modelCatalog.read().then(value => {
      if (!active) return
      setCatalog(value)
    }).catch(error => {
      if (active) setNotice({ tone: 'error', message: `无法读取模型目录缓存：${errorText(error)}` })
    })
    return () => { active = false }
  }, [modelCatalog])

  const update = useCallback((next: WebPreferences): void => {
    setPreferences(next)
    setAdvancedJson(JSON.stringify(next.insight, null, 2))
    setAdvancedDirty(false)
    setGeminiJson(JSON.stringify(next.geminiSemantics ?? {}, null, 2))
    setGeminiDirty(false)
  }, [])

  const save = useCallback(async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (api === undefined || preferences === undefined || saving) return
    let next = clonePreferences(preferences)
    if (advancedDirty) {
      try {
        const parsed: unknown = JSON.parse(advancedJson)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('高级 JSON 必须是对象。')
        next = { ...next, insight: parsed as InsightConfigV1 }
      } catch (error) {
        setNotice({ tone: 'error', message: `高级 JSON 无法保存：${errorText(error)}` })
        return
      }
    }
    if (geminiDirty) {
      try {
        const parsed: unknown = JSON.parse(geminiJson)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Gemini 选择器必须是对象。')
        next = { ...next, geminiSemantics: parsed as WebPreferences['geminiSemantics'] }
      } catch (error) {
        setNotice({ tone: 'error', message: `Gemini 选择器无法保存：${errorText(error)}` })
        return
      }
    }
    setSaving(true)
    try {
      const saved = await api.save({ expectedRevision: preferences.revision, value: next })
      update(saved)
      setNotice({ tone: 'info', message: '设置已保存；只影响新运行。' })
    } catch (error) {
      setNotice({ tone: 'error', message: `设置保存未完成：${errorText(error)}。请重新读取后再保存。` })
    } finally {
      setSaving(false)
    }
  }, [advancedDirty, advancedJson, api, geminiDirty, geminiJson, preferences, saving, update])

  const refreshModelCatalog = useCallback(async (): Promise<void> => {
    if (modelCatalog === undefined || catalogRefreshing) return
    setCatalogRefreshing(true)
    try {
      const targetModel = catalogTargetModel.trim() || preferences?.web.modelLabel.trim()
      const value = await modelCatalog.refresh({
        ...(targetModel ? { modelLabel: targetModel } : {}),
      })
      setCatalog(value)
      setNotice({ tone: 'info', message: '已读取目标浏览器模型目录；没有提交模型请求。' })
    } catch (error) {
      setNotice({ tone: 'error', message: `目标浏览器模型目录刷新未完成：${errorText(error)}` })
    } finally {
      setCatalogRefreshing(false)
    }
  }, [catalogRefreshing, catalogTargetModel, modelCatalog, preferences?.web.modelLabel])

  if (api === undefined) {
    return createElement('main', { style: panelStyle }, [
      createElement('header', { key: 'hero', style: heroStyle }, [
        createElement('p', { key: 'eyebrow', style: eyebrowStyle }, 'Solar Web'),
        createElement('h1', { key: 'title', style: titleStyle }, '网页和洞察设置'),
        createElement('p', { key: 'message', role: 'status', style: leadStyle }, '本机设置控制通道尚未连接。'),
      ]),
    ])
  }
  if (preferences === undefined) {
    return createElement('main', { style: panelStyle }, [
      createElement('header', { key: 'hero', style: heroStyle }, [
        createElement('p', { key: 'eyebrow', style: eyebrowStyle }, 'Solar Web'),
        createElement('h1', { key: 'title', style: titleStyle }, '网页和洞察设置'),
        createElement('p', { key: 'message', role: notice?.tone === 'error' ? 'alert' : 'status', style: leadStyle }, loading ? '正在读取设置…' : notice?.message ?? '尚未读取设置。'),
      ]),
    ])
  }

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const next = event.key === 'Home' ? 'web'
      : event.key === 'End' ? 'insight'
        : event.key === 'ArrowLeft' || event.key === 'ArrowRight'
          ? activeTab === 'web' ? 'insight' : 'web'
          : undefined
    if (next === undefined) return
    event.preventDefault()
    setActiveTab(next)
    document.getElementById(`${fieldId}-tab-${next}`)?.focus()
  }

  const current = preferences
  const catalogModels = availableCatalogModels(catalog)
  const effectiveWebModel = current.web.modelLabel.trim() || catalog?.selected.modelLabel || ''
  const catalogWebEfforts = availableCatalogEfforts(catalog, effectiveWebModel)

  const webPanel = createElement('section', { key: 'web-panel', id: `${fieldId}-panel-web`, role: 'tabpanel', 'aria-labelledby': `${fieldId}-tab-web`, style: { ...surfaceStyle, display: activeTab === 'web' ? 'grid' : 'none' }, hidden: activeTab !== 'web' }, [
    createElement('div', { key: 'header', style: surfaceHeaderStyle }, [
      createElement('h2', { key: 'title', style: headingStyle }, 'ChatGPT 网页回答'),
      createElement('p', { key: 'hint', style: mutedStyle }, '模型和思考档留空时，跟随目标浏览器当前选择。选择目录项后才会固定该标签。'),
    ]),
    createElement(CatalogTargetSummary, { key: 'catalog', catalog, onRefresh: () => { void refreshModelCatalog() }, refreshing: catalogRefreshing }),
    createElement('div', { key: 'choices', style: fieldGridStyle }, [
      createElement(CatalogChoiceField, { key: 'model', id: `${fieldId}-web-model-choice`, label: '模型', value: current.web.modelLabel, choices: catalogModels, catalogObserved: catalog !== undefined, allowEmpty: true, onChange: value => setPreferences({ ...current, web: { ...current.web, modelLabel: value } }) }),
      createElement(CatalogChoiceField, { key: 'effort', id: `${fieldId}-web-effort-choice`, label: `思考档${effectiveWebModel ? ` · ${effectiveWebModel}` : ''}`, value: current.web.effortLabel, choices: catalogWebEfforts, catalogObserved: catalog !== undefined, allowEmpty: true, onChange: value => setPreferences({ ...current, web: { ...current.web, effortLabel: value } }) }),
    ]),
    createElement('details', { key: 'manual', style: detailStyle }, [
      createElement('summary', { key: 'summary', style: detailSummaryStyle }, '精确标签与查询选项'),
      createElement('p', { key: 'hint', style: mutedStyle }, '适合固定一个目录尚未匹配的精确标签；保存时会原样保留。'),
      createElement('div', { key: 'catalog-query', style: { ...fieldGridStyle, padding: '0 0 14px' } }, [
        createElement(CatalogChoiceField, { key: 'target-model', id: `${fieldId}-catalog-target-model`, label: '刷新时检查模型', value: catalogTargetModel, choices: catalogModels, catalogObserved: catalog !== undefined, allowEmpty: true, emptyLabel: '使用上方模型；未固定时跟随网页', onChange: setCatalogTargetModel }),
        catalog === undefined
          ? null
          : createElement('div', { key: 'observation', style: { ...fieldStyle, alignContent: 'end' } }, [
            createElement('span', { key: 'label', style: labelStyle }, '最近观测'),
            createElement('p', { key: 'value', style: mutedStyle }, `本地时间：${formatCatalogObservedAt(catalog.observedAt)} · 档位属于：${catalog.effortModelLabel}`),
          ]),
      ]),
      createElement('div', { key: 'fields', style: { ...fieldGridStyle, padding: '0 0 14px' } }, [
        createElement(InputField, { key: 'model', id: `${fieldId}-web-model-manual`, label: '模型标签', value: current.web.modelLabel, onChange: event => setPreferences({ ...current, web: { ...current.web, modelLabel: event.target.value } }) }),
        createElement(InputField, { key: 'effort', id: `${fieldId}-web-effort-manual`, label: '思考档标签', value: current.web.effortLabel, onChange: event => setPreferences({ ...current, web: { ...current.web, effortLabel: event.target.value } }) }),
      ]),
    ]),
  ])

  const stageRows = STAGES.map((stage, index) => {
    const requested = stageRequested(current.insight, stage.id)
    return createElement('details', { key: stage.id, style: detailStyle }, [
      createElement('summary', { key: 'summary', style: detailSummaryStyle, 'aria-label': `编辑第 ${index + 1} 阶段：${stage.label}` }, [
        createElement('span', { key: 'number', style: stageNumberStyle, 'aria-hidden': true }, String(index + 1)),
        createElement('span', { key: 'text', style: summaryTextStyle }, [
          createElement('strong', { key: 'label', style: { overflowWrap: 'anywhere' } }, stage.label),
          createElement('span', { key: 'summary', style: mutedStyle }, stageSummary(requested)),
        ]),
      ]),
      createElement('div', { key: 'fields', style: { ...fieldGridStyle, padding: '0 0 18px' } }, stageFields(current, stage.id, requested, catalog, fieldId, update)),
    ])
  })

  const advanced = createElement('details', { key: 'advanced', style: { ...detailStyle, marginTop: 8 } }, [
    createElement('summary', { key: 'summary', style: detailSummaryStyle }, '高级配置与 Gemini 选择器'),
    createElement('div', { key: 'fields', style: { display: 'grid', gap: 14, padding: '0 0 16px' } }, [
      createElement('p', { key: 'hint', style: mutedStyle }, '按需编辑完整 JSON；保存仍使用同一版本校验。'),
      createElement('label', { key: 'json-label', htmlFor: `${fieldId}-insight-json`, style: labelStyle }, 'Insight JSON'),
      createElement('textarea', { key: 'json', id: `${fieldId}-insight-json`, 'aria-label': 'Insight JSON', value: advancedJson, rows: 14, onChange: (event: ChangeEvent<HTMLTextAreaElement>) => { setAdvancedJson(event.target.value); setAdvancedDirty(true) }, style: { ...inputStyle, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.78rem' } }),
      createElement('label', { key: 'gemini-label', htmlFor: `${fieldId}-gemini-semantics`, style: labelStyle }, 'Gemini 选择器 JSON'),
      createElement('textarea', { key: 'gemini-json', id: `${fieldId}-gemini-semantics`, 'aria-label': 'Gemini 选择器 JSON', value: geminiJson, rows: 8, onChange: (event: ChangeEvent<HTMLTextAreaElement>) => { setGeminiJson(event.target.value); setGeminiDirty(true) }, style: { ...inputStyle, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.78rem' } }),
      createElement(InputField, { key: 'wait', id: `${fieldId}-research-wait`, label: '研究等待毫秒数', type: 'number', value: String(current.insight.researchWaitMs), onChange: event => update(updateNumber(current, 'researchWaitMs', event.target.value)) }),
      createElement(TemplateField, { key: 'delivery-template', id: `${fieldId}-delivery-template`, label: '交付提示模板', value: current.insight.delivery.template.text, onChange: event => update(updateTemplate(current, 'delivery', event.target.value)) }),
    ]),
  ])

  const insightPanel = createElement('section', { key: 'insight-panel', id: `${fieldId}-panel-insight`, role: 'tabpanel', 'aria-labelledby': `${fieldId}-tab-insight`, style: { ...surfaceStyle, display: activeTab === 'insight' ? 'grid' : 'none' }, hidden: activeTab !== 'insight' }, [
    createElement('div', { key: 'header', style: surfaceHeaderStyle }, [
      createElement('p', { key: 'eyebrow', style: eyebrowStyle }, '洞察分析'),
      createElement('h2', { key: 'title', style: headingStyle }, '阶段配置'),
      createElement('p', { key: 'hint', style: mutedStyle }, '按阶段查看当前模型；目录选择只提供给 ChatGPT 网页阶段，Codex 与 Gemini 保持手工配置。完整流程是否能启动见下方就绪状态。'),
    ]),
    createElement(GeminiReadinessSummary, { key: 'gemini-readiness', preferences: current }),
    createElement('div', { key: 'stages', style: stageListStyle }, stageRows),
    advanced,
  ])

  return createElement('main', { style: panelStyle }, [
    createElement('header', { key: 'hero', style: heroStyle }, [
      createElement('p', { key: 'eyebrow', style: eyebrowStyle }, 'Solar Web'),
      createElement('h1', { key: 'title', style: titleStyle }, '网页和洞察设置'),
      createElement('p', { key: 'lead', style: leadStyle }, '选择网页回答方式，按需配置研究流程。'),
    ]),
    createElement('nav', { key: 'tabs', role: 'tablist', 'aria-label': '设置分类', style: tabListStyle }, [
      createElement('button', { key: 'web', id: `${fieldId}-tab-web`, type: 'button', role: 'tab', 'aria-selected': activeTab === 'web', 'aria-controls': `${fieldId}-panel-web`, tabIndex: activeTab === 'web' ? 0 : -1, onKeyDown: handleTabKeyDown, onClick: () => setActiveTab('web'), style: activeTab === 'web' ? activeTabStyle : tabStyle }, '网页回答'),
      createElement('button', { key: 'insight', id: `${fieldId}-tab-insight`, type: 'button', role: 'tab', 'aria-selected': activeTab === 'insight', 'aria-controls': `${fieldId}-panel-insight`, tabIndex: activeTab === 'insight' ? 0 : -1, onKeyDown: handleTabKeyDown, onClick: () => setActiveTab('insight'), style: activeTab === 'insight' ? activeTabStyle : tabStyle }, '洞察分析'),
    ]),
    notice === undefined ? null : createElement('p', { key: 'notice', role: notice.tone === 'error' ? 'alert' : 'status', style: { ...noticeStyle, borderColor: notice.tone === 'error' ? 'var(--dsw-alias-state-error-primary)' : '#5c4c96', color: notice.tone === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'inherit' } }, notice.message),
    createElement('form', { key: 'form', onSubmit: save, style: { display: 'grid', gap: 20, minWidth: 0, paddingBottom: 72 } }, [webPanel, insightPanel, createElement('footer', { key: 'footer', style: footerStyle }, [
      createElement('span', { key: 'status', style: mutedStyle }, saving ? '正在保存…' : loading ? '正在读取…' : '更改不会自动保存'),
      createElement('div', { key: 'actions', style: actionRowStyle }, [
        createElement('button', { key: 'reload', type: 'button', disabled: saving || loading, onClick: () => { void read() }, style: buttonStyle }, '重新读取'),
        createElement('button', { key: 'save', type: 'submit', disabled: saving || loading, style: primaryButtonStyle }, saving ? '保存中…' : '保存设置'),
      ]),
    ])]),
  ])
}
