import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  PhysicalOperatorProfileOwner,
  PhysicalOperatorProfileReasoningEffort,
  PhysicalOperatorRoutingPolicy,
} from '@deepseek-ai/dsh-tool-physical-operator/client'
import type {
  ContinualHarnessMode,
  ExecutionModelPreference,
  ModelAllocationObjective,
  PlannerVerifierPreference,
  RlmAutonomousMode,
  RlmExecutionMode,
} from '@deepseek-ai/dsh-tool-orchestration/client'
import type { DebateExecutionMode } from '@deepseek-ai/dsh-tool-debate/client'
import type { DesktopResidentDashboard } from '../contracts.ts'
import { loadResidentDashboard, type BrowserRequest } from './ResidentOperatorsPanel.tsx'

/** Command face injected by the Desktop client registration. */
export interface PhysicalOperatorRoutingInjected {
  /** Authenticated same-origin request from the shared browser Connection seam. */
  request: BrowserRequest
  /** Persist one Session routing policy through the host command boundary. */
  select: (policy: PhysicalOperatorRoutingPolicy) => Promise<string | null>
  /** Persist one product's optional model and effort fields through the host command boundary. */
  selectProfile: (
    operatorId: PhysicalOperatorProfileOwner,
    model?: string,
    effort?: PhysicalOperatorProfileReasoningEffort,
  ) => Promise<string | null>
  /** Persist TaskGraph RLM, Continuous Harness, and quality/cost strategy. */
  selectOrchestrationStrategy: (
    rlm: RlmExecutionMode,
    autonomous: RlmAutonomousMode,
    continualHarness: ContinualHarnessMode,
    optimization: ModelAllocationObjective,
    plannerVerifierPreference: PlannerVerifierPreference,
    executionPreference: ExecutionModelPreference,
  ) => Promise<string | null>
  /** Persist the per-Session Debate admission mode through the host command boundary. */
  selectDebateMode: (mode: DebateExecutionMode) => Promise<string | null>
}

/** Full props for the additive composer-row execution strategy selector. */
export type PhysicalOperatorRoutingControlProps =
  PropsRuntime<'conversation.input.right'> & InjectFace<PhysicalOperatorRoutingInjected>

const LABELS: Record<PhysicalOperatorRoutingPolicy, string> = {
  auto: '智能协作',
  direct: '仅主模型',
  codex: '优先 Codex',
  'claude-code': '优先 Claude Code',
  'chatgpt-web': 'ChatGPT 网页订阅',
}

const RLM_EXECUTION_LABELS: Record<RlmExecutionMode, string> = {
  auto: '自动（系统选择）',
  enabled: 'RLM（Prime 递归）',
  disabled: '标准（单 Agent）',
}

const AUTONOMOUS_MODE_LABELS: Record<RlmAutonomousMode, string> = {
  auto: '自动（按任务判断）',
  enabled: '自主闭环',
  disabled: '关闭',
}

/** User-visible mutually exclusive execution mechanism. */
export type OrchestrationExecutionMechanism = 'auto' | 'standard' | 'rlm' | 'debate'

const EXECUTION_MECHANISM_LABELS: Record<OrchestrationExecutionMechanism, string> = {
  auto: '自动（系统选择）',
  standard: '标准（单 Agent）',
  rlm: 'RLM（Prime 递归）',
  debate: 'Debate（多 Agent 辩论）',
}

/** Collapse independently persisted RLM and Debate modes into one human-facing choice. */
export function orchestrationExecutionMechanism(
  rlm: RlmExecutionMode,
  debate: DebateExecutionMode,
): OrchestrationExecutionMechanism {
  if (debate === 'enabled') return 'debate'
  if (rlm === 'enabled') return 'rlm'
  if (rlm === 'disabled' && debate === 'disabled') return 'standard'
  return 'auto'
}

/** Stable Chinese label for one unified execution mechanism. */
export function orchestrationExecutionMechanismLabel(mode: OrchestrationExecutionMechanism): string {
  return EXECUTION_MECHANISM_LABELS[mode]
}

type SaveExecutionSubmode = (mode: 'auto' | 'enabled' | 'disabled') => Promise<string | null>

async function executionModeStep(
  label: string,
  operation: () => Promise<string | null>,
): Promise<string | null> {
  const failure = await operation()
  return failure === null ? null : `${label}失败：${failure}`
}

/**
 * Persist one unified choice without ever enabling RLM and Debate together.
 * The non-target mechanism is closed before the target mechanism is enabled;
 * a failed step is returned verbatim so the controlled select can be retried.
 */
export async function changeOrchestrationExecutionMechanism(
  current: { readonly rlm: RlmExecutionMode; readonly debate: DebateExecutionMode },
  target: OrchestrationExecutionMechanism,
  saveRlm: SaveExecutionSubmode,
  saveDebate: SaveExecutionSubmode,
): Promise<string | null> {
  let rlm = current.rlm
  let debate = current.debate
  const setRlm = async (mode: RlmExecutionMode, label: string): Promise<string | null> => {
    if (rlm === mode) return null
    const failure = await executionModeStep(label, () => saveRlm(mode))
    if (failure === null) rlm = mode
    return failure
  }
  const setDebate = async (mode: DebateExecutionMode, label: string): Promise<string | null> => {
    if (debate === mode) return null
    const failure = await executionModeStep(label, () => saveDebate(mode))
    if (failure === null) debate = mode
    return failure
  }

  if (target === 'rlm') {
    return await setDebate('disabled', '关闭 Debate')
      ?? await setRlm('enabled', '启用 RLM')
  }
  if (target === 'debate') {
    return await setRlm('disabled', '关闭 RLM')
      ?? await setDebate('enabled', '启用 Debate')
  }
  if (target === 'standard') {
    return await setDebate('disabled', '关闭 Debate')
      ?? await setRlm('disabled', '启用标准模式')
  }

  const closeExplicit = rlm === 'enabled'
    ? await setRlm('disabled', '关闭 RLM')
    : debate === 'enabled'
      ? await setDebate('disabled', '关闭 Debate')
      : null
  return closeExplicit
    ?? await setRlm('auto', '启用 RLM 自动选择')
    ?? await setDebate('auto', '启用 Debate 自动选择')
}

/** User-facing execution-mechanism label; `auto` remains the product default. */
export function orchestrationExecutionModeLabel(mode: RlmExecutionMode): string {
  return RLM_EXECUTION_LABELS[mode]
}

/** User-facing label for Prime-compatible Autonomous Mode. */
export function orchestrationAutonomousModeLabel(mode: RlmAutonomousMode): string {
  return AUTONOMOUS_MODE_LABELS[mode]
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
    'chatgpt-web': 'ChatGPT 网页版',
  } as const)[policy]
}

/** Refresh quickly while the collaboration panel is visible, conservatively while closed. */
export function physicalOperatorDashboardRefreshMs(open: boolean): number {
  return open ? 10_000 : 60_000
}

/** Viewport-safe fixed position for the collaboration panel. */
export function physicalOperatorStrategyPanelPosition(
  trigger: { readonly top: number; readonly right: number; readonly bottom: number },
  panelHeight: number,
  viewport: { readonly width: number; readonly height: number },
): { readonly right: number; readonly top: number } {
  const margin = 12
  const gap = 8
  const safeHeight = Math.max(0, Math.min(panelHeight, viewport.height - (margin * 2)))
  const above = trigger.top - margin - gap
  const below = viewport.height - trigger.bottom - margin - gap
  const top = above >= safeHeight
    ? trigger.top - gap - safeHeight
    : below >= safeHeight
      ? trigger.bottom + gap
      : above >= below
        ? margin
        : viewport.height - margin - safeHeight
  return {
    right: Math.max(margin, viewport.width - trigger.right),
    top: Math.max(margin, Math.min(top, viewport.height - margin - safeHeight)),
  }
}

/** Render the logged collaboration policy next to the primary chat-model selector. */
export function PhysicalOperatorRoutingControl({
  useProjection,
  session,
  input,
  request,
  select,
  selectProfile,
  selectOrchestrationStrategy,
  selectDebateMode,
}: PhysicalOperatorRoutingControlProps) {
  const routing = useProjection('physicalOperatorRouting')
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dashboard, setDashboard] = useState<DesktopResidentDashboard>()
  const [page, setPage] = useState<'basic' | 'advanced'>('basic')
  const [panelPosition, setPanelPosition] = useState({ right: 12, top: 12 })
  const alive = useRef(true)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLElement>(null)

  useEffect(() => () => { alive.current = false }, [])
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async (): Promise<void> => {
      try {
        setDashboard(await loadResidentDashboard(undefined, controller.signal, request))
      } catch {
        // The Resident status panel owns availability diagnostics; selection remains fail-closed.
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => { void refresh() }, physicalOperatorDashboardRefreshMs(open))
      }
    }
    void refresh()
    return () => {
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [open, request])
  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const rect = trigger.current?.getBoundingClientRect()
      if (rect === undefined) return
      setPanelPosition(physicalOperatorStrategyPanelPosition(
        rect,
        panel.current?.getBoundingClientRect().height ?? 520,
        { width: window.innerWidth, height: window.innerHeight },
      ))
    }
    const close = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    document.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      document.removeEventListener('keydown', close)
    }
  }, [dashboard, open, page])
  const profileProjection = useProjection('physicalOperatorProfiles')
  const orchestrationPreferences = useProjection('orchestrationExecutionPreferences')
  const debatePreferences = useProjection('debateExecutionPreferences')
  if (routing === undefined) return null

  const locked = session.removed || input.phase !== 'plain' || saving
  const currentLabel = physicalOperatorRoutingSummary(routing.currentValue)
  const profileOwner = routing.currentValue === 'codex'
    || routing.currentValue === 'claude-code'
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
  const persist = (operation: () => Promise<string | null>): void => {
    setSaving(true)
    setError(null)
    void operation().then((failure) => {
      if (!alive.current) return
      setSaving(false)
      setError(failure)
    }, (reason: unknown) => {
      if (!alive.current) return
      setSaving(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  const choose = (id: string): void => {
    const policy = routing.options.find(option => option.value === id)?.value
    if (policy === undefined || policy === routing.currentValue) return
    persist(() => select(policy))
  }
  const saveProfile = (
    operatorId: PhysicalOperatorProfileOwner,
    modelValue?: string,
    effortValue?: PhysicalOperatorProfileReasoningEffort,
  ): void => {
    persist(() => selectProfile(operatorId, modelValue, effortValue))
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
    saveProfile(profileOwner, nextModel, nextEffort)
  }
  const chooseEffort = (id: string): void => {
    if (profileOwner === undefined) return
    const nextEffort = id === 'auto' ? undefined : id as PhysicalOperatorProfileReasoningEffort
    saveProfile(profileOwner, selectedModel, nextEffort)
  }
  const saveOrchestrationStrategy = (
    rlm: RlmExecutionMode,
    autonomous: RlmAutonomousMode,
    continualHarness: ContinualHarnessMode,
    optimization: ModelAllocationObjective,
    plannerVerifierPreference = orchestrationPreferences?.plannerVerifierPreference ?? 'codex-sol',
    executionPreference = orchestrationPreferences?.executionPreference ?? 'luna-first',
  ): void => {
    persist(() => selectOrchestrationStrategy(
      rlm,
      autonomous,
      continualHarness,
      optimization,
      plannerVerifierPreference,
      executionPreference,
    ))
  }
  const chooseExecutionMechanism = (target: OrchestrationExecutionMechanism): void => {
    if (orchestrationPreferences === undefined || debatePreferences === undefined) return
    persist(() => changeOrchestrationExecutionMechanism(
      { rlm: orchestrationPreferences.rlm, debate: debatePreferences.mode },
      target,
      mode => selectOrchestrationStrategy(
        mode,
        orchestrationPreferences.autonomous,
        orchestrationPreferences.continualHarness,
        orchestrationPreferences.optimization,
        orchestrationPreferences.plannerVerifierPreference,
        orchestrationPreferences.executionPreference,
      ),
      selectDebateMode,
    ))
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
        title={error ?? '设置主模型、订阅态 Codex/Claude Code/ChatGPT 网页版与 TaskGraph 执行机制'}
        onClick={() => {
          setOpen((value) => {
            if (!value) setPage('basic')
            return !value
          })
        }}
      >
        <span>协作 · {saving ? '保存中' : currentLabel}</span>
        <IconChevronDownOutline14 />
      </button>
      {open && createPortal(
        <div className="dshDesktopOperatorStrategyBackdrop" role="presentation" onMouseDown={() => { setOpen(false) }}>
          <section
            ref={panel}
            className="dshDesktopOperatorStrategyPanel"
            role="dialog"
            aria-label="协作方式"
            style={panelPosition}
            onMouseDown={(event) => { event.stopPropagation() }}
          >
            <header>
              <div><strong>协作方式</strong><small>先选择谁参与当前会话；需要时再调整 TaskGraph 高级调度。</small></div>
              <button type="button" aria-label="关闭协作方式" onClick={() => { setOpen(false) }}>×</button>
            </header>
            <nav className="dshDesktopOperatorStrategyTabs" aria-label="协作设置页面">
              <button type="button" data-selected={page === 'basic' || undefined} onClick={() => { setPage('basic') }}>基础</button>
              <button type="button" data-selected={page === 'advanced' || undefined} onClick={() => { setPage('advanced') }}>高级调度</button>
            </nav>
            <div className="dshDesktopOperatorStrategyBody">
              <div className="dshDesktopOperatorStrategyOptions" hidden={page !== 'basic'}>
                {routing.options.map(option => (
                  <button
                    key={option.value}
                    type="button"
                    data-selected={option.value === routing.currentValue || undefined}
                    disabled={saving}
                    onClick={() => { choose(option.value) }}
                  >
                    <span className="dshDesktopOperatorStrategyRadio" aria-hidden="true" />
                    <span>
                      <strong>{physicalOperatorRoutingLabel(option.value)}</strong>
                      <small>{physicalOperatorRoutingDescription(option.value)}</small>
                    </span>
                  </button>
                ))}
              </div>
              {profileOwner !== undefined && (
                <div className="dshDesktopOperatorProfilePreferences" hidden={page !== 'basic'}>
                  <div>
                    <strong>{profileOwner === 'codex' ? 'Codex' : 'Claude Code'} 模型偏好</strong>
                    <small>{profileOwner === 'codex'
                      ? 'Sol 适合规划验证，Terra/Luna 适合并行执行。'
                      : 'Opus/Fable 适合复杂规划，Sonnet 适合高效执行。'}</small>
                  </div>
                  <label>
                    <span>执行模型</span>
                    <select
                      aria-label="执行模型"
                      value={selectedModel ?? 'auto'}
                      disabled={saving || provider === undefined || !provider.available}
                      onChange={(event) => { chooseModel(event.currentTarget.value) }}
                    >
                      <option value="auto">按任务推荐</option>
                      {provider?.models.map(option => <option key={option.model} value={option.model}>{option.displayName}</option>)}
                    </select>
                  </label>
                  <label>
                    <span>{profileOwner === 'claude-code' ? '思考强度' : '推理强度'}</span>
                    <select
                      aria-label={profileOwner === 'claude-code' ? 'Claude 思考强度' : 'Codex 推理强度'}
                      value={selectedEffort ?? 'auto'}
                      disabled={saving || provider === undefined || !provider.available || availableEfforts.length === 0}
                      onChange={(event) => { chooseEffort(event.currentTarget.value) }}
                    >
                      <option value="auto">按任务推荐</option>
                      {availableEfforts.map(effort => (
                        <option key={effort} value={effort}>
                          {physicalOperatorEffortLabel(effort, profileOwner)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {provider === undefined
                    ? <p>正在读取当前执行端的原生订阅模型目录…</p>
                    : !provider.available
                      ? <p>当前连接的执行端不可用：{provider.unavailableReason ?? '订阅资格未通过'}</p>
                      : <p>{model?.displayName ?? '按任务推荐'}：{model?.description ?? '由系统按任务与配额选择。'}{model?.supportsAdaptiveThinking === true ? ' 支持原生自适应思考。' : ''}</p>}
                </div>
              )}
              {orchestrationPreferences !== undefined && debatePreferences !== undefined && (
                <div className="dshDesktopOperatorProfilePreferences dshDesktopOperatorTaskGraphPreferences" data-page={page}>
                  <div>
                    <strong>{page === 'basic' ? '执行机制' : 'TaskGraph 高级调度'}</strong>
                    <small>{page === 'basic'
                      ? '普通任务保持自动；需要对比时再固定 Standard、RLM 或 Debate。'
                      : '只影响多节点任务，不改变“基础”页选择的主协作算子。'}</small>
                  </div>
                  <label>
                    <span>执行机制</span>
                    <select
                      aria-label="执行机制"
                      value={orchestrationExecutionMechanism(orchestrationPreferences.rlm, debatePreferences.mode)}
                      disabled={saving}
                      onChange={(event) => {
                        chooseExecutionMechanism(event.currentTarget.value as OrchestrationExecutionMechanism)
                      }}
                    >
                      <option value="auto">{orchestrationExecutionMechanismLabel('auto')}</option>
                      <option value="standard">{orchestrationExecutionMechanismLabel('standard')}</option>
                      <option value="rlm">{orchestrationExecutionMechanismLabel('rlm')}</option>
                      <option value="debate">{orchestrationExecutionMechanismLabel('debate')}</option>
                    </select>
                  </label>
                  <label>
                    <span>自主闭环</span>
                    <select
                      aria-label="自主闭环策略"
                      value={orchestrationPreferences.autonomous}
                      disabled={saving}
                      onChange={(event) => {
                        saveOrchestrationStrategy(
                          orchestrationPreferences.rlm,
                          event.currentTarget.value as RlmAutonomousMode,
                          orchestrationPreferences.continualHarness,
                          orchestrationPreferences.optimization,
                        )
                      }}
                    >
                      <option value="auto">{orchestrationAutonomousModeLabel('auto')}</option>
                      <option value="enabled">{orchestrationAutonomousModeLabel('enabled')}</option>
                      <option value="disabled">{orchestrationAutonomousModeLabel('disabled')}</option>
                    </select>
                  </label>
                  <label>
                    <span>持续 Harness</span>
                    <select
                      aria-label="持续 Harness 策略"
                      value={orchestrationPreferences.continualHarness}
                      disabled={saving}
                      onChange={(event) => {
                        saveOrchestrationStrategy(
                          orchestrationPreferences.rlm,
                          orchestrationPreferences.autonomous,
                          event.currentTarget.value as ContinualHarnessMode,
                          orchestrationPreferences.optimization,
                        )
                      }}
                    >
                      <option value="auto">自动</option>
                      <option value="off">关闭</option>
                      <option value="session">当前会话</option>
                      <option value="workspace">当前工作区</option>
                      <option value="global">所有工作区（用户级）</option>
                    </select>
                  </label>
                  <label>
                    <span>综合目标</span>
                    <select
                      aria-label="模型分配目标"
                      value={orchestrationPreferences.optimization}
                      disabled={saving}
                      onChange={(event) => {
                        saveOrchestrationStrategy(
                          orchestrationPreferences.rlm,
                          orchestrationPreferences.autonomous,
                          orchestrationPreferences.continualHarness,
                          event.currentTarget.value as ModelAllocationObjective,
                        )
                      }}
                    >
                      <option value="balanced">综合最优</option>
                      <option value="quality">质量优先</option>
                      <option value="speed">速度优先</option>
                      <option value="economy">成本优先</option>
                    </select>
                  </label>
                  <label>
                    <span>规划与验证</span>
                    <select
                      aria-label="规划与验证模型策略"
                      value={orchestrationPreferences.plannerVerifierPreference}
                      disabled={saving}
                      onChange={(event) => {
                        saveOrchestrationStrategy(
                          orchestrationPreferences.rlm,
                          orchestrationPreferences.autonomous,
                          orchestrationPreferences.continualHarness,
                          orchestrationPreferences.optimization,
                          event.currentTarget.value as PlannerVerifierPreference,
                          orchestrationPreferences.executionPreference,
                        )
                      }}
                    >
                      <option value="codex-sol">Codex Sol 优先</option>
                      <option value="claude-frontier">Claude Opus/Fable 优先</option>
                      <option value="best-high-tier">最佳高阶模型</option>
                    </select>
                  </label>
                  <label>
                    <span>代码执行</span>
                    <select
                      aria-label="代码执行模型策略"
                      value={orchestrationPreferences.executionPreference}
                      disabled={saving}
                      onChange={(event) => {
                        saveOrchestrationStrategy(
                          orchestrationPreferences.rlm,
                          orchestrationPreferences.autonomous,
                          orchestrationPreferences.continualHarness,
                          orchestrationPreferences.optimization,
                          orchestrationPreferences.plannerVerifierPreference,
                          event.currentTarget.value as ExecutionModelPreference,
                        )
                      }}
                    >
                      <option value="luna-first">Codex Luna 优先</option>
                      <option value="claude-sonnet">Claude Sonnet 优先</option>
                      <option value="balanced">调度器综合选择</option>
                    </select>
                  </label>
                  <p>Codex 和 Claude Code 均使用原生订阅目录。系统按目标、健康与配额分配并行节点；计费 API 只作最后兜底。</p>
                </div>
              )}
              {page === 'advanced' && orchestrationPreferences === undefined && (
                <p className="dshDesktopOperatorStrategyEmpty">当前会话尚未加载 TaskGraph 高级策略。</p>
              )}
              {error !== null && <p className="dshDesktopOperatorStrategyError" role="status">更新失败：{error}</p>}
            </div>
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
    auto: '推荐。按任务类型在主模型、Codex 与 Claude Code 之间选择；复杂任务可进入 TaskGraph。',
    direct: '始终由当前主聊天模型回答，不调用执行助手。',
    codex: '代码、调试和测试任务优先交给 Codex；短问答仍由主模型处理。',
    'claude-code': '分析、架构和长上下文任务优先交给 Claude Code；短问答仍由主模型处理。',
    'chatgpt-web': '仅在你明确选择时通过已登录的 ChatGPT 网页订阅执行；不进入智能自动，模型与强度由网页端管理。',
  } as const)[policy]
}

/** Provider-specific Chinese effort label with an outcome-oriented explanation. */
export function physicalOperatorEffortLabel(
  effort: string,
  owner: PhysicalOperatorProfileOwner = 'codex',
): string {
  const level = ({ low: '低', medium: '中', high: '高', xhigh: '很高', max: '最大', ultra: '极限' } as Record<string, string>)[effort] ?? effort
  return `${level} · ${effortDescription(effort, owner)}`
}

function effortDescription(effort: string, owner: PhysicalOperatorProfileOwner): string {
  const descriptions = owner === 'claude-code'
    ? {
      low: 'Claude 快速思考',
      medium: 'Claude 日常平衡',
      high: 'Claude 深入思考',
      xhigh: 'Claude 更长推理预算',
      max: 'Claude 最大思考预算',
    }
    : {
      low: '低延迟，轻量推理',
      medium: '日常任务的速度与质量平衡',
      high: '复杂任务的深度推理',
      xhigh: '更高推理深度',
      max: '产品支持的最大常规强度',
      ultra: 'Codex 最大推理并自动任务分派',
    }
  return (descriptions as Record<string, string>)[effort] ?? effort
}
