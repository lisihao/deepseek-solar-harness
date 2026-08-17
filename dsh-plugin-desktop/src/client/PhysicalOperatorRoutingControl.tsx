import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  PhysicalOperatorProfileOwner,
  PhysicalOperatorProfileReasoningEffort,
  PhysicalOperatorRoutingPolicy,
} from '@deepseek-ai/dsh-tool-physical-operator/client'
import type { DesktopResidentDashboard } from '../resident-dashboard-contracts.ts'
import { loadResidentDashboard } from './ResidentOperatorsPanel.tsx'

/** Command face injected by the Desktop client registration. */
export interface PhysicalOperatorRoutingInjected {
  /** Persist one Session routing policy through the host command boundary. */
  select: (policy: PhysicalOperatorRoutingPolicy) => Promise<string | null>
  /** Persist one product's optional model and effort fields through the host command boundary. */
  selectProfile: (
    operatorId: PhysicalOperatorProfileOwner,
    model?: string,
    effort?: PhysicalOperatorProfileReasoningEffort,
  ) => Promise<string | null>
}

/** Full props for the additive composer-row execution strategy selector. */
export type PhysicalOperatorRoutingControlProps =
  PropsRuntime<'conversation.input.right'> & InjectFace<PhysicalOperatorRoutingInjected>

const LABELS: Record<PhysicalOperatorRoutingPolicy, string> = {
  auto: '智能协作',
  direct: '仅主模型',
  codex: '优先 Codex',
  'claude-code': '优先 Claude Code',
}

/** Stable Chinese display label for one host-owned routing value. */
export function physicalOperatorRoutingLabel(policy: PhysicalOperatorRoutingPolicy): string {
  return LABELS[policy]
}

/** Compact composer summary that distinguishes collaboration from the primary chat model. */
export function physicalOperatorRoutingSummary(policy: PhysicalOperatorRoutingPolicy): string {
  return ({
    auto: '智能协作',
    direct: '仅主模型',
    codex: 'Codex',
    'claude-code': 'Claude Code',
  } as const)[policy]
}

/** Render the logged collaboration policy next to the primary chat-model selector. */
export function PhysicalOperatorRoutingControl({
  useProjection,
  session,
  input,
  select,
  selectProfile,
}: PhysicalOperatorRoutingControlProps) {
  const routing = useProjection('physicalOperatorRouting')
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dashboard, setDashboard] = useState<DesktopResidentDashboard>()
  const [panelPosition, setPanelPosition] = useState({ right: 12, bottom: 44 })
  const alive = useRef(true)
  const trigger = useRef<HTMLButtonElement>(null)

  useEffect(() => () => { alive.current = false }, [])
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async (): Promise<void> => {
      try {
        setDashboard(await loadResidentDashboard(undefined, controller.signal))
      } catch {
        // The Resident status panel owns availability diagnostics; selection remains fail-closed.
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => { void refresh() }, 60_000)
      }
    }
    void refresh()
    return () => {
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [])
  useEffect(() => {
    if (!open) return
    const place = (): void => {
      const rect = trigger.current?.getBoundingClientRect()
      if (rect === undefined) return
      setPanelPosition({
        right: Math.max(12, window.innerWidth - rect.right),
        bottom: Math.max(44, window.innerHeight - rect.top + 8),
      })
    }
    const close = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    place()
    window.addEventListener('resize', place)
    document.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('resize', place)
      document.removeEventListener('keydown', close)
    }
  }, [open])
  const profileProjection = useProjection('physicalOperatorProfiles')
  if (routing === undefined) return null

  const locked = session.removed || input.phase !== 'plain' || saving
  const currentLabel = physicalOperatorRoutingSummary(routing.currentValue)
  const profileOwner = routing.currentValue === 'codex' || routing.currentValue === 'claude-code'
    ? routing.currentValue
    : undefined
  const provider = profileOwner === undefined
    ? undefined
    : dashboard?.providers.find(candidate => candidate.operatorId === profileOwner)
  const preference = profileOwner === undefined ? undefined : profileProjection?.profiles[profileOwner]
  const selectedModel = preference?.model
  const model = selectedModel === undefined
    ? provider?.models.find(candidate => candidate.isDefault) ?? provider?.models[0]
    : provider?.models.find(candidate => candidate.model === selectedModel)
  const selectedEffort = preference?.effort
  const availableEfforts = selectedModel === undefined
    ? [...new Set(provider?.models.flatMap(option => option.supportedEfforts) ?? profileProjection?.efforts ?? [])]
    : model?.supportedEfforts ?? []
  const choose = (id: string): void => {
    const policy = routing.options.find(option => option.value === id)?.value
    if (policy === undefined || policy === routing.currentValue) return
    setSaving(true)
    setError(null)
    void select(policy).then((failure) => {
      if (!alive.current) return
      setSaving(false)
      setError(failure)
    }, (reason: unknown) => {
      if (!alive.current) return
      setSaving(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  const saveProfile = (
    operatorId: PhysicalOperatorProfileOwner,
    modelValue?: string,
    effortValue?: PhysicalOperatorProfileReasoningEffort,
  ): void => {
    setSaving(true)
    setError(null)
    void selectProfile(operatorId, modelValue, effortValue).then((failure) => {
      if (!alive.current) return
      setSaving(false)
      setError(failure)
    }, (reason: unknown) => {
      if (!alive.current) return
      setSaving(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  const chooseModel = (id: string): void => {
    if (profileOwner === undefined) return
    const nextModel = id === 'auto' ? undefined : provider?.models.find(candidate => candidate.model === id)?.model
    const nextOption = nextModel === undefined ? undefined : provider?.models.find(candidate => candidate.model === nextModel)
    const effortSupported = selectedEffort !== undefined && (nextOption === undefined
      ? provider?.models.some(candidate => candidate.supportedEfforts.includes(selectedEffort)) === true
      : nextOption.supportedEfforts.includes(selectedEffort))
    const nextEffort = effortSupported
      ? selectedEffort
      : undefined
    saveProfile(profileOwner, nextModel, nextEffort as PhysicalOperatorProfileReasoningEffort | undefined)
  }
  const chooseEffort = (id: string): void => {
    if (profileOwner === undefined) return
    const nextEffort = id === 'auto' ? undefined : id as PhysicalOperatorProfileReasoningEffort
    saveProfile(profileOwner, selectedModel, nextEffort)
  }

  return (
    <span className="dshDesktopOperatorRoutingWrap">
      <button
        ref={trigger}
        type="button"
        className="dshDesktopOperatorRoutingChip"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={locked}
        title={error ?? '设置主模型是否邀请订阅态 Codex 或 Claude Code 协作'}
        onClick={() => { setOpen(value => !value) }}
      >
        <span>协作 · {saving ? '保存中' : currentLabel}</span>
        <IconChevronDownOutline14 />
      </button>
      {open && createPortal(
        <div className="dshDesktopOperatorStrategyBackdrop" role="presentation" onMouseDown={() => { setOpen(false) }}>
          <section
            className="dshDesktopOperatorStrategyPanel"
            role="dialog"
            aria-label="协作方式"
            style={panelPosition}
            onMouseDown={event => { event.stopPropagation() }}
          >
            <header>
              <div><strong>协作方式</strong><small>主模型负责对话；Codex 和 Claude Code 只在需要时作为执行助手。</small></div>
              <button type="button" aria-label="关闭协作方式" onClick={() => { setOpen(false) }}>×</button>
            </header>
            <div className="dshDesktopOperatorStrategyOptions">
              {routing.options.map(option => (
                <button
                  key={option.value}
                  type="button"
                  data-selected={option.value === routing.currentValue || undefined}
                  disabled={saving}
                  onClick={() => { choose(option.value) }}
                >
                  <span className="dshDesktopOperatorStrategyRadio" aria-hidden="true" />
                  <span><strong>{physicalOperatorRoutingLabel(option.value)}</strong><small>{physicalOperatorRoutingDescription(option.value)}</small></span>
                </button>
              ))}
            </div>
            {profileOwner !== undefined && (
              <div className="dshDesktopOperatorProfilePreferences">
                <div><strong>{profileOwner === 'codex' ? 'Codex' : 'Claude Code'} 高级偏好</strong><small>通常保持“按任务推荐”即可。</small></div>
                <label>
                  <span>执行模型</span>
                  <select
                    aria-label="执行模型"
                    value={selectedModel ?? 'auto'}
                    disabled={saving || provider === undefined || !provider.available}
                    onChange={event => { chooseModel(event.currentTarget.value) }}
                  >
                    <option value="auto">按任务推荐</option>
                    {provider?.models.map(option => <option key={option.model} value={option.model}>{option.displayName}</option>)}
                  </select>
                </label>
                <label>
                  <span>推理强度</span>
                  <select
                    aria-label="推理强度"
                    value={selectedEffort ?? 'auto'}
                    disabled={saving || provider === undefined || !provider.available || availableEfforts.length === 0}
                    onChange={event => { chooseEffort(event.currentTarget.value) }}
                  >
                    <option value="auto">按任务推荐</option>
                    {availableEfforts.map(effort => <option key={effort} value={effort}>{physicalOperatorEffortLabel(effort)}</option>)}
                  </select>
                </label>
                {provider === undefined
                  ? <p>正在读取原生订阅模型目录…</p>
                  : !provider.available
                    ? <p>当前不可用：{provider.unavailableReason ?? '订阅资格未通过'}</p>
                    : <p>偏好按当前对话保存。持久任务首次运行后，本工作区会固定实际模型和强度以保证重启连续；如需更换，请先在左侧“物理算子”中重置该会话。</p>}
              </div>
            )}
            {error !== null && <p className="dshDesktopOperatorStrategyError" role="status">更新失败：{error}</p>}
          </section>
        </div>,
        document.body,
      )}
    </span>
  )
}

/** Human-facing consequence of one collaboration policy. */
export function physicalOperatorRoutingDescription(policy: PhysicalOperatorRoutingPolicy): string {
  return ({
    auto: '推荐。按任务类型在主模型、Codex 与 Claude Code 之间选择。',
    direct: '始终由当前主聊天模型回答，不调用执行助手。',
    codex: '代码、调试和测试任务优先交给 Codex；短问答仍由主模型处理。',
    'claude-code': '分析、架构和长上下文任务优先交给 Claude Code；短问答仍由主模型处理。',
  } as const)[policy]
}

/** Chinese effort label with an outcome-oriented explanation. */
export function physicalOperatorEffortLabel(effort: string): string {
  return `${({ low: '低', medium: '中', high: '高', xhigh: '很高', max: '最大', ultra: '极限' } as Record<string, string>)[effort] ?? effort} · ${effortDescription(effort)}`
}

function effortDescription(effort: string): string {
  return ({
    low: '低延迟，轻量推理',
    medium: '日常任务的速度与质量平衡',
    high: '复杂任务的深度推理',
    xhigh: '更高推理深度',
    max: '产品支持的最大常规强度',
    ultra: 'Codex 最大推理并自动任务分派',
  } as Record<string, string>)[effort] ?? effort
}
