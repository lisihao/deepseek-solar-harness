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
  type ReactElement,
} from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { InsightConfigV1, InsightModelSelection } from './insight-contract.js'
import type { WebPreferences, WebPreferencesSaveInput } from './preferences.js'

export interface PreferencesClientApi {
  read(): Promise<WebPreferences>
  save(input: WebPreferencesSaveInput): Promise<WebPreferences>
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
  gap: 16,
  minWidth: 0,
  width: '100%',
  boxSizing: 'border-box',
  padding: 16,
  color: 'var(--dsw-alias-label-primary)',
  background: 'var(--dsw-alias-bg-base)',
}

const sectionStyle: CSSProperties = {
  display: 'grid',
  gap: 10,
  minWidth: 0,
  padding: 14,
  border: '1px solid var(--dsw-alias-settings-card-stroke)',
  borderRadius: 10,
  background: 'var(--dsw-alias-settings-card-fill)',
}

const fieldStyle: CSSProperties = { display: 'grid', gap: 6, minWidth: 0 }
const inputStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  minWidth: 0,
  maxWidth: '100%',
  padding: '8px 10px',
  border: '1px solid var(--dsw-alias-settings-card-stroke)',
  borderRadius: 6,
  background: 'var(--dsw-alias-bg-module-platform)',
  color: 'inherit',
  font: 'inherit',
}
const actionRowStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', minWidth: 0 }
const buttonStyle: CSSProperties = {
  minHeight: 32,
  maxWidth: '100%',
  padding: '6px 10px',
  border: '1px solid var(--dsw-alias-settings-card-stroke)',
  borderRadius: 6,
  background: 'var(--dsw-alias-bg-module-platform)',
  color: 'inherit',
  cursor: 'pointer',
  overflowWrap: 'anywhere',
}
const mutedStyle: CSSProperties = { margin: 0, color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' }

type ConfigStageKey = 'clarification' | 'plan' | 'research' | 'fallbackResearch' | 'critique' | 'polish' | 'fallbackPolish'

const STAGES: readonly { readonly id: Exclude<ConfigStageKey, 'clarification'>; readonly label: string; readonly mode: boolean }[] = [
  { id: 'plan', label: 'Gemini 研究计划', mode: true },
  { id: 'research', label: 'Gemini 研究', mode: true },
  { id: 'critique', label: 'ChatGPT 核验', mode: true },
  { id: 'polish', label: 'Gemini 润色', mode: true },
  { id: 'fallbackResearch', label: 'GPT 回落研究', mode: true },
  { id: 'fallbackPolish', label: 'GPT 回落润色', mode: true },
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

function InputField(props: {
  readonly id: string
  readonly label: string
  readonly value: string
  readonly onChange: (event: ChangeEvent<HTMLInputElement>) => void
  readonly type?: 'text' | 'number'
}): ReactElement {
  return createElement('div', { style: fieldStyle }, [
    createElement('label', { key: 'label', htmlFor: props.id }, props.label),
    createElement('input', { key: 'input', id: props.id, type: props.type ?? 'text', value: props.value, onChange: props.onChange, style: inputStyle }),
  ])
}

function TemplateField(props: { readonly id: string; readonly label: string; readonly value: string; readonly onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void }): ReactElement {
  return createElement('div', { style: fieldStyle }, [
    createElement('label', { key: 'label', htmlFor: props.id }, props.label),
    createElement('textarea', { key: 'input', id: props.id, value: props.value, onChange: props.onChange, rows: 4, style: inputStyle }),
  ])
}

function stageRequested(config: InsightConfigV1, stage: Exclude<ConfigStageKey, 'clarification'>): InsightModelSelection {
  return (config as unknown as Record<ConfigStageKey, { requested: InsightModelSelection }>)[stage].requested
}

function stageTemplate(config: InsightConfigV1, stage: Exclude<ConfigStageKey, 'clarification'>): string {
  return (config as unknown as Record<ConfigStageKey, { template: { text: string } }>)[stage].template.text
}

export function PreferencesPanel({ api }: { readonly api?: PreferencesClientApi }): ReactElement {
  const fieldId = useId()
  const [preferences, setPreferences] = useState<WebPreferences | undefined>()
  const [advancedJson, setAdvancedJson] = useState('')
  const [advancedDirty, setAdvancedDirty] = useState(false)
  const [geminiJson, setGeminiJson] = useState('{}')
  const [geminiDirty, setGeminiDirty] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
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
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Gemini 语义选择器 JSON 必须是对象。')
        next = { ...next, geminiSemantics: parsed as WebPreferences['geminiSemantics'] }
      } catch (error) {
        setNotice({ tone: 'error', message: `Gemini 语义选择器 JSON 无法保存：${errorText(error)}` })
        return
      }
    }
    setSaving(true)
    try {
      const saved = await api.save({ expectedRevision: preferences.revision, value: next })
      update(saved)
      setNotice({ tone: 'info', message: '设置已保存；只影响新运行，已经开始的运行保留原设置快照。' })
    } catch (error) {
      setNotice({ tone: 'error', message: `设置保存未完成：${errorText(error)}。请重新读取后再保存。` })
    } finally {
      setSaving(false)
    }
  }, [advancedDirty, advancedJson, api, geminiDirty, geminiJson, preferences, saving, update])

  if (api === undefined) {
    return createElement('main', { style: panelStyle }, [
      createElement('h1', { key: 'title', style: { margin: 0, fontSize: '1.25rem' } }, '网页和洞察设置'),
      createElement('p', { key: 'message', role: 'status', style: mutedStyle }, '本机设置控制通道尚未连接。'),
    ])
  }
  if (preferences === undefined) {
    return createElement('main', { style: panelStyle }, [
      createElement('h1', { key: 'title', style: { margin: 0, fontSize: '1.25rem' } }, '网页和洞察设置'),
      createElement('p', { key: 'message', role: notice?.tone === 'error' ? 'alert' : 'status', style: mutedStyle }, loading ? '正在读取设置…' : notice?.message ?? '尚未读取设置。'),
    ])
  }

  const current = preferences
  const modelNotice = createElement('p', { key: 'model-notice', style: mutedStyle }, '请求模型、档位和模式只是配置标签，不代表网站当前已提供对应选项；不会自动别名，也不会把不可用选择静默回落到其他配额。')
  const hasGeminiSemantics = current.geminiSemantics !== undefined && Object.keys(current.geminiSemantics).length > 0
  const geminiNotice = createElement('p', { key: 'gemini-notice', style: mutedStyle }, !hasGeminiSemantics
    ? 'Gemini Deep Research 的语义选择器尚未在实时界面中核实；当前未配置选择器，不能声称该流程可用。若取得新的界面证据，请在高级 JSON 中填写并保存，实际运行仍需单独核对。'
    : 'Gemini Deep Research 的语义选择器来自显式配置，实时界面可用性仍未核实；保存配置不会声称该流程已经可用。')
  const webSection = createElement('section', { key: 'web', style: sectionStyle }, [
    createElement('h2', { key: 'title', style: { margin: 0, fontSize: '1rem' } }, '普通 ChatGPT 网页请求'),
    createElement('p', { key: 'hint', style: mutedStyle }, '默认请求标签为 GPT-6 / medium；实际网页档位以提交前观测结果为准。'),
    createElement(InputField, { key: 'model', id: `${fieldId}-web-model`, label: '模型标签', value: current.web.modelLabel, onChange: (event: ChangeEvent<HTMLInputElement>) => setPreferences({ ...current, web: { ...current.web, modelLabel: event.target.value } }) }),
    createElement(InputField, { key: 'effort', id: `${fieldId}-web-effort`, label: '思考档标签', value: current.web.effortLabel, onChange: (event: ChangeEvent<HTMLInputElement>) => setPreferences({ ...current, web: { ...current.web, effortLabel: event.target.value } }) }),
  ])

  const clarification = current.insight.clarification
  const clarificationSection = createElement('section', { key: 'clarification', style: sectionStyle }, [
    createElement('h2', { key: 'title', style: { margin: 0, fontSize: '1rem' } }, '澄清阶段'),
    createElement(InputField, { key: 'model-id', id: `${fieldId}-clarify-model-id`, label: '精确 modelId', value: clarification.requested.modelId ?? '', onChange: event => update(updateRequested(current, 'clarification', 'modelId', event.target.value)) }),
    createElement(InputField, { key: 'model-label', id: `${fieldId}-clarify-model-label`, label: '模型标签', value: clarification.requested.modelLabel, onChange: event => update(updateRequested(current, 'clarification', 'modelLabel', event.target.value)) }),
    createElement(InputField, { key: 'effort', id: `${fieldId}-clarify-effort`, label: '思考档标签', value: clarification.requested.effortLabel ?? '', onChange: event => update(updateRequested(current, 'clarification', 'effortLabel', event.target.value)) }),
    createElement(InputField, { key: 'rounds', id: `${fieldId}-clarify-rounds`, label: '最多轮数', type: 'number', value: String(clarification.maxRounds), onChange: event => update(updateNumber(current, 'maxRounds', event.target.value)) }),
    createElement(InputField, { key: 'questions', id: `${fieldId}-clarify-questions`, label: '每轮最多问题数', type: 'number', value: String(clarification.maxQuestionsPerRound), onChange: event => update(updateNumber(current, 'maxQuestionsPerRound', event.target.value)) }),
    createElement(TemplateField, { key: 'template', id: `${fieldId}-clarify-template`, label: '澄清 prompt 模板', value: clarification.template.text, onChange: event => update(updateTemplate(current, 'clarification', event.target.value)) }),
  ])

  const stageSections = STAGES.map(stage => {
    const requested = stageRequested(current.insight, stage.id)
    return createElement('section', { key: stage.id, style: sectionStyle }, [
      createElement('h2', { key: 'title', style: { margin: 0, fontSize: '1rem' } }, stage.label),
      createElement(InputField, { key: 'model', id: `${fieldId}-${stage.id}-model`, label: '模型标签', value: requested.modelLabel, onChange: event => update(updateRequested(current, stage.id, 'modelLabel', event.target.value)) }),
      createElement(InputField, { key: 'effort', id: `${fieldId}-${stage.id}-effort`, label: '思考档标签', value: requested.effortLabel ?? '', onChange: event => update(updateRequested(current, stage.id, 'effortLabel', event.target.value)) }),
      stage.mode ? createElement(InputField, { key: 'mode', id: `${fieldId}-${stage.id}-mode`, label: '模式标签', value: requested.modeLabel ?? '', onChange: event => update(updateRequested(current, stage.id, 'modeLabel', event.target.value)) }) : null,
      createElement(TemplateField, { key: 'template', id: `${fieldId}-${stage.id}-template`, label: 'prompt 模板', value: stageTemplate(current.insight, stage.id), onChange: event => update(updateTemplate(current, stage.id, event.target.value)) }),
    ])
  })

  const delivery = current.insight.delivery
  const advanced = createElement('section', { key: 'advanced', style: sectionStyle }, [
    createElement('h2', { key: 'title', style: { margin: 0, fontSize: '1rem' } }, '高级 Insight JSON'),
    createElement('p', { key: 'hint', style: mutedStyle }, '这里保留完整配置字段。保存时服务端会重新计算每个模板 hash，并拒绝未知字段、非 JSON 数值和超长文本。'),
    createElement('textarea', { key: 'json', value: advancedJson, rows: 18, onChange: (event: ChangeEvent<HTMLTextAreaElement>) => { setAdvancedJson(event.target.value); setAdvancedDirty(true) }, style: { ...inputStyle, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }),
    createElement('label', { key: 'gemini-label', htmlFor: `${fieldId}-gemini-semantics` }, 'Gemini 语义选择器 JSON（可选，未核实的 Deep Research 选择器不要自行填写）'),
    createElement('textarea', { key: 'gemini-json', id: `${fieldId}-gemini-semantics`, value: geminiJson, rows: 10, onChange: (event: ChangeEvent<HTMLTextAreaElement>) => { setGeminiJson(event.target.value); setGeminiDirty(true) }, style: { ...inputStyle, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }),
    createElement(TemplateField, { key: 'delivery-template', id: `${fieldId}-delivery-template`, label: '交付 prompt 模板', value: delivery.template.text, onChange: event => update(updateTemplate(current, 'delivery', event.target.value)) }),
    createElement(InputField, { key: 'wait', id: `${fieldId}-research-wait`, label: '研究等待毫秒数', type: 'number', value: String(current.insight.researchWaitMs), onChange: event => update(updateNumber(current, 'researchWaitMs', event.target.value)) }),
  ])

  return createElement('main', { style: panelStyle }, [
    createElement('header', { key: 'header', style: { display: 'grid', gap: 6, minWidth: 0 } }, [
      createElement('h1', { key: 'title', style: { margin: 0, fontSize: '1.25rem', overflowWrap: 'anywhere' } }, '网页和洞察设置'),
      modelNotice,
      geminiNotice,
      createElement('p', { key: 'snapshot', style: mutedStyle }, '这些设置只影响新运行；已经开始的运行继续使用各自保存的配置快照。'),
    ]),
    notice === undefined ? null : createElement('p', { key: 'notice', role: notice.tone === 'error' ? 'alert' : 'status', style: { ...sectionStyle, color: notice.tone === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'inherit' } }, notice.message),
    createElement('form', { key: 'form', onSubmit: save }, [webSection, clarificationSection, ...stageSections, advanced, createElement('div', { key: 'actions', style: actionRowStyle }, [
      createElement('button', { key: 'save', type: 'submit', disabled: saving || loading, style: buttonStyle }, saving ? '正在保存…' : '保存设置'),
      createElement('button', { key: 'reload', type: 'button', disabled: saving || loading, onClick: () => { void read() }, style: buttonStyle }, '重新读取'),
    ])]),
  ])
}
