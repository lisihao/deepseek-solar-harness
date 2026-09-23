import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionModels } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-plan-mode/client'
import type {
  ModelDirectoryState,
  ModelSelectInjected,
} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {
  PhysicalOperatorProfileOwner,
  PhysicalOperatorProfileReasoningEffort,
  PhysicalOperatorRoutingPolicy,
  PhysicalOperatorRoutingTarget,
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
import {
  WebCoordinationSetup,
  type WebCoordinationStatus,
} from './WebCoordinationSetup.tsx'

/** Command face injected by the Desktop client registration. */
export interface PhysicalOperatorRoutingInjected extends Pick<ModelSelectInjected, 'directory'> {
  /** Authenticated same-origin request from the shared browser Connection seam. */
  request: BrowserRequest
  /** Refresh the current Session's model directory without changing its selection. */
  refreshModels: () => Promise<SessionModels>
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
  standard: '标准（关闭 RLM / Debate）',
  rlm: 'RLM（仅 TaskGraph 节点）',
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

/** Resolve the mechanism that owns the next direct message when both preference projections are available.
 * @param rlm - persisted RLM execution preference, when its projection is loaded.
 * @param debate - persisted Debate execution preference, when its projection is loaded.
 * @returns effective mechanism, or undefined while one preference projection is absent.
 */
export function physicalOperatorEffectiveExecutionMechanism(
  rlm: RlmExecutionMode | undefined,
  debate: DebateExecutionMode | undefined,
): OrchestrationExecutionMechanism | undefined {
  if (debate === 'enabled') return 'debate'
  if (rlm === undefined || debate === undefined) return undefined
  return orchestrationExecutionMechanism(rlm, debate)
}

/** Render the effective mechanism instead of implying that the selected primary model owns a Debate turn.
 * @param policy - selected physical-operator policy shown by the primary route control.
 * @param rlm - persisted RLM execution preference, when its projection is loaded.
 * @param debate - persisted Debate execution preference, when its projection is loaded.
 * @param directory - shared primary-model directory, when its projection has loaded.
 * @returns a compact label for the next direct message.
 */
export function physicalOperatorEffectiveExecutionLabel(
  policy: PhysicalOperatorRoutingPolicy,
  rlm: RlmExecutionMode | undefined,
  debate: DebateExecutionMode | undefined,
  directory?: ModelDirectoryState,
): string {
  const mechanism = physicalOperatorEffectiveExecutionMechanism(rlm, debate)
  if (mechanism === 'debate') return orchestrationExecutionMechanismLabel(mechanism)
  return physicalOperatorRoutingSummary(physicalOperatorMainModel(directory) ?? policy)
}

/** Resolve the explicitly selected physical primary model, when the shared directory reports one. */
function physicalOperatorMainModel(
  directory: ModelDirectoryState | undefined,
): PhysicalOperatorRoutingTarget | undefined {
  if (directory?.current?.provider !== 'dsh-physical-operator') return undefined
  switch (directory.current.model) {
    case 'codex':
    case 'claude-code':
    case 'chatgpt-web':
      return directory.current.model
    default:
      return undefined
  }
}

/**
 * Whether the shared primary-model directory reports the browser-only ChatGPT route.
 * @param directory - shared primary-model directory, when its projection has loaded.
 * @returns whether the current route is the ChatGPT browser operator.
 */
export function physicalOperatorMainModelIsChatGPTWeb(directory: ModelDirectoryState | undefined): boolean {
  return physicalOperatorMainModel(directory) === 'chatgpt-web'
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
  current: { readonly rlm: RlmExecutionMode; readonly debate: DebateExecutionMode; readonly autonomous?: RlmAutonomousMode },
  target: OrchestrationExecutionMechanism,
  saveRlm: SaveExecutionSubmode,
  saveDebate: SaveExecutionSubmode,
): Promise<string | null> {
  let rlm = current.rlm
  let debate = current.debate
  const setRlm = async (mode: RlmExecutionMode, label: string): Promise<string | null> => {
    if (rlm === mode && !(mode === 'disabled' && current.autonomous === 'enabled')) return null
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

/** Refresh interval after a visible collaboration panel has loaded its provider projection. */
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

function refreshFailureMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message
  if (typeof reason === 'string') return reason
  if (reason !== null && typeof reason === 'object' && 'message' in reason && typeof reason.message === 'string') {
    return reason.message
  }
  return '未知错误'
}

/** Render the logged collaboration policy next to the primary chat-model selector. */
export function PhysicalOperatorRoutingControl({
  useProjection,
  session,
  input,
  directory,
  sessionId,
  refreshModels,
  request,
  select,
  selectProfile,
  selectOrchestrationStrategy,
  selectDebateMode,
}: PhysicalOperatorRoutingControlProps) {
  const routing = useProjection('physicalOperatorRouting')
  const modelDirectory = useSyncExternalStore(
    fn => directory.subscribe(fn),
    () => directory.getSnapshot(),
  )
  const profileProjection = useProjection('physicalOperatorProfiles')
  const orchestrationPreferences = useProjection('orchestrationExecutionPreferences')
  const debatePreferences = useProjection('debateExecutionPreferences')
  const plan = useProjection('plan')
  const planSelected = plan !== undefined && (plan.pending ? !plan.active : plan.active)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dashboard, setDashboard] = useState<DesktopResidentDashboard>()
  const [webCoordinationStatus, setWebCoordinationStatus] = useState<WebCoordinationStatus>()
  const [refreshing, setRefreshing] = useState(false)
  const [refreshMessage, setRefreshMessage] = useState<string>()
  const [webRefreshVersion, setWebRefreshVersion] = useState(0)
  const [page, setPage] = useState<'basic' | 'advanced'>('basic')
  const [panelPosition, setPanelPosition] = useState({ right: 12, top: 12 })
  const alive = useRef(true)
  const refreshController = useRef<AbortController>()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLElement>(null)
  const selectedMainModel = physicalOperatorMainModel(modelDirectory)
  const selectedProfileOwner = selectedMainModel === 'codex' || selectedMainModel === 'claude-code'
    ? selectedMainModel
    : undefined
  const effectiveMechanism = physicalOperatorEffectiveExecutionMechanism(
    orchestrationPreferences?.rlm,
    debatePreferences?.mode,
  )
  const savedProfileOwner = routing?.currentValue === 'codex' || routing?.currentValue === 'claude-code'
    ? routing.currentValue
    : undefined
  const webCoordinationReady = selectedMainModel === 'chatgpt-web'
    && webCoordinationStatus?.mode === 'coordinator'
  const profileOwner = effectiveMechanism === 'debate'
    ? undefined
    : selectedProfileOwner
      ?? (selectedMainModel === undefined || webCoordinationReady ? savedProfileOwner : undefined)
  const dashboardEligible = open
    && profileOwner !== undefined
    && effectiveMechanism !== 'debate'
    && modelDirectory.status !== 'idle'
    && modelDirectory.status !== 'loading'

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      refreshController.current?.abort()
    }
  }, [])
  useEffect(() => {
    if (!dashboardEligible) return
    const controller = new AbortController()
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    setDashboard(undefined)
    const refresh = async (): Promise<void> => {
      try {
        const next = await loadResidentDashboard(undefined, controller.signal, request)
        if (active && !controller.signal.aborted) setDashboard(next)
      } catch {
        // The Resident status panel owns availability diagnostics; selection remains fail-closed.
      } finally {
        if (active && !controller.signal.aborted) {
          timer = setTimeout(() => { void refresh() }, physicalOperatorDashboardRefreshMs(true))
        }
      }
    }
    void refresh()
    return () => {
      active = false
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [dashboardEligible, profileOwner, request])
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
  if (routing === undefined) return null

  const locked = session.removed || input.phase !== 'plain' || saving
  const taskGraphInactive = effectiveMechanism === 'debate'
    || (selectedMainModel === 'chatgpt-web' && !webCoordinationReady)
  const routingPreferencesLocked = locked
    || (selectedMainModel === 'chatgpt-web' && !webCoordinationReady)
    || effectiveMechanism === 'debate'
  const currentLabel = physicalOperatorEffectiveExecutionLabel(
    routing.currentValue,
    orchestrationPreferences?.rlm,
    debatePreferences?.mode,
    modelDirectory,
  )
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
  const selectedModelUnavailable = selectedModel !== undefined
    && provider !== undefined
    && model === undefined
  const selectedModelPending = selectedModel !== undefined && provider === undefined
  const selectedEffortUnavailable = selectedEffort !== undefined
    && provider !== undefined
    && !availableEfforts.includes(selectedEffort)
  const selectedEffortPending = selectedEffort !== undefined && provider === undefined
  const persist = (operation: () => Promise<string | null>): void => {
    if (locked) return
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
    if (routingPreferencesLocked) return
    const policy = routing.options.find(option => option.value === id)?.value
    if (policy === undefined || policy === routing.currentValue) return
    persist(() => select(policy))
  }
  const saveProfile = (
    operatorId: PhysicalOperatorProfileOwner,
    modelValue?: string,
    effortValue?: PhysicalOperatorProfileReasoningEffort,
  ): void => {
    if (locked) return
    persist(() => selectProfile(operatorId, modelValue, effortValue))
  }
  const chooseModel = (id: string): void => {
    if (locked || profileOwner === undefined || provider === undefined || !provider.available) return
    const nextModel = id === 'auto' ? undefined : provider.models.find(candidate => candidate.model === id)?.model
    if (id !== 'auto' && nextModel === undefined) return
    const nextOption = nextModel === undefined ? undefined : provider.models.find(candidate => candidate.model === nextModel)
    const effortSupported = selectedEffort !== undefined && (nextOption === undefined
      ? provider.models.some(candidate => candidate.supportedEfforts.includes(selectedEffort))
      : nextOption.supportedEfforts.includes(selectedEffort))
    const nextEffort = effortSupported
      ? selectedEffort
      : undefined
    saveProfile(profileOwner, nextModel, nextEffort)
  }
  const chooseEffort = (id: string): void => {
    if (locked || profileOwner === undefined || provider === undefined || !provider.available) return
    if (id !== 'auto' && !availableEfforts.includes(id)) return
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
    if (locked || taskGraphInactive || (rlm === 'disabled' && autonomous === 'enabled')) return
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
    if (locked || debatePreferences === undefined
      || (target === 'debate' && planSelected)
      || (target === 'rlm' && taskGraphInactive)) return
    if (orchestrationPreferences === undefined) {
      if (target === 'standard' && debatePreferences.mode !== 'disabled') {
        persist(() => selectDebateMode('disabled'))
      }
      return
    }
    persist(() => changeOrchestrationExecutionMechanism(
      { rlm: orchestrationPreferences.rlm, debate: debatePreferences.mode, autonomous: orchestrationPreferences.autonomous },
      target,
      mode => selectOrchestrationStrategy(
        mode,
        mode === 'disabled' && orchestrationPreferences.autonomous === 'enabled'
          ? 'disabled'
          : orchestrationPreferences.autonomous,
        orchestrationPreferences.continualHarness,
        orchestrationPreferences.optimization,
        orchestrationPreferences.plannerVerifierPreference,
        orchestrationPreferences.executionPreference,
      ),
      selectDebateMode,
    ))
  }
  const refreshModelsAndOperators = (): void => {
    if (locked || refreshing) return
    const controller = new AbortController()
    refreshController.current = controller
    setRefreshing(true)
    setRefreshMessage('正在刷新模型与算子…')
    const modelRefresh = refreshModels()
    const dashboardRefresh = loadResidentDashboard(undefined, controller.signal, request, { refresh: true })
    const webUrl = new URL('/api/chatgpt-web', window.location.origin)
    webUrl.searchParams.set('catalog', '1')
    webUrl.searchParams.set('refresh', '1')
    webUrl.searchParams.set('session_id', String(sessionId))
    const webRefresh = request(webUrl, { cache: 'no-store', signal: controller.signal })
    void Promise.allSettled([modelRefresh, dashboardRefresh, webRefresh]).then((results) => {
      if (!alive.current || controller.signal.aborted) return
      const [modelResult, dashboardResult, webResult] = results
      const messages: string[] = []
      if (modelResult.status === 'fulfilled') {
        const failures = modelResult.value.failures.map(failure => failure.name)
        messages.push(failures.length === 0
          ? '模型目录已刷新'
          : `模型目录已刷新，暂不可用：${failures.join('、')}`)
      } else {
        messages.push(`模型目录刷新失败：${refreshFailureMessage(modelResult.reason)}`)
      }
      if (dashboardResult.status === 'fulfilled') {
        setDashboard(dashboardResult.value)
        messages.push('原生算子目录已刷新')
      } else {
        messages.push(`原生算子目录刷新失败：${refreshFailureMessage(dashboardResult.reason)}`)
      }
      if (webResult.status === 'fulfilled') {
        if (webResult.value.ok) {
          setWebRefreshVersion(version => version + 1)
          messages.push('ChatGPT Web 目录已刷新')
        } else if (webResult.value.status === 404) {
          messages.push('ChatGPT Web 未安装，已跳过')
        } else if (webResult.value.status === 409) {
          messages.push('ChatGPT Web 正忙，请完成当前请求后重试')
        } else {
          messages.push(`ChatGPT Web 刷新失败（HTTP ${String(webResult.value.status)}）`)
        }
      } else {
        messages.push(`ChatGPT Web 刷新失败：${refreshFailureMessage(webResult.reason)}`)
      }
      setRefreshMessage(messages.join('；'))
      setRefreshing(false)
      if (refreshController.current === controller) refreshController.current = undefined
    })
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
        title={error ?? '设置当前主模型的下游协作偏好、原生执行配置与 TaskGraph 执行机制'}
        onClick={() => {
          if (locked) return
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
              <div>
                <button
                  type="button"
                  aria-label="刷新模型与算子"
                  disabled={locked || refreshing}
                  onClick={refreshModelsAndOperators}
                >
                  {refreshing ? '刷新中…' : '刷新模型与算子'}
                </button>
                <button type="button" aria-label="关闭协作方式" disabled={locked || refreshing} onClick={() => { if (!locked && !refreshing) setOpen(false) }}>×</button>
              </div>
            </header>
            {refreshMessage !== undefined && <p role="status">{refreshMessage}</p>}
            <nav className="dshDesktopOperatorStrategyTabs" aria-label="协作设置页面">
              <button type="button" data-selected={page === 'basic' || undefined} disabled={locked} onClick={() => { if (!locked) setPage('basic') }}>基础</button>
              <button type="button" data-selected={page === 'advanced' || undefined} disabled={locked} onClick={() => { if (!locked) setPage('advanced') }}>高级调度</button>
            </nav>
            <div className="dshDesktopOperatorStrategyBody">
              <div className="dshDesktopOperatorStrategyOptions" hidden={page !== 'basic'}>
                {routing.options.map(option => (
                  <button
                    key={option.value}
                    type="button"
                    data-selected={option.value === routing.currentValue || undefined}
                    disabled={routingPreferencesLocked}
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
              {selectedMainModel !== undefined && effectiveMechanism !== 'debate' && (
                <div className="dshDesktopOperatorProfilePreferences dshDesktopOperatorTaskGraphPreferences" hidden={page !== 'basic'} role="status">
                  <div>
                    <strong>当前主模型：{physicalOperatorRoutingSummary(selectedMainModel)}</strong>
                    <small>{`下面设置的是下游协作偏好，不会更改当前主模型。当前保存：“${physicalOperatorRoutingLabel(routing.currentValue)}”。${selectedMainModel === 'chatgpt-web'
                      ? webCoordinationReady
                        ? ' 工具协作模式已选择；请在下方完成 Custom MCP 连接。'
                        : ' ChatGPT 网页版需要先完成下方的协作设置。'
                      : ''}`}</small>
                  </div>
                </div>
              )}
              {selectedMainModel === 'chatgpt-web' && (
                <WebCoordinationSetup
                  request={request}
                  open={open}
                  selected
                  locked={locked || refreshing}
                  hidden={page !== 'basic'}
                  sessionId={String(sessionId)}
                  refreshVersion={webRefreshVersion}
                  onStatusChange={setWebCoordinationStatus}
                />
              )}
              {effectiveMechanism === 'debate' && (
                <div className="dshDesktopOperatorProfilePreferences dshDesktopOperatorTaskGraphPreferences" hidden={page !== 'basic'} role="status">
                  <div>
                    <strong>当前生效：Debate</strong>
                    <small>下一条直接消息将由 Debate 阵容执行；保存的主模型和协作偏好在 Debate 期间不生效。退出后，下一条消息按当前主模型和协作偏好恢复会话路由。</small>
                  </div>
                  <button
                    type="button"
                    disabled={locked}
                    onClick={() => { chooseExecutionMechanism('standard') }}
                  >
                    退出 Debate（恢复会话路由）
                  </button>
                </div>
              )}
              {profileOwner !== undefined && effectiveMechanism !== 'debate' && (
                <div className="dshDesktopOperatorProfilePreferences" hidden={page !== 'basic'}>
                  <div>
                    <strong>{profileOwner === 'codex' ? 'Codex' : 'Claude Code'} 模型偏好</strong>
                    <small>{selectedMainModel === undefined || webCoordinationReady
                      ? '这是下游协作端的原生配置，不会更改当前主模型。'
                      : '这是当前主模型的原生配置；下方按钮单独设置下游协作偏好。'}</small>
                    <small>{profileOwner === 'codex'
                      ? 'Sol 适合规划验证，Terra/Luna 适合并行执行。'
                      : 'Opus/Fable 适合复杂规划，Sonnet 适合高效执行。'}</small>
                  </div>
                  <label>
                    <span>执行模型</span>
                    <select
                      aria-label="执行模型"
                      value={selectedModel ?? 'auto'}
                      disabled={locked || provider === undefined || !provider.available}
                      onChange={(event) => { chooseModel(event.currentTarget.value) }}
                    >
                      <option value="auto">按任务推荐</option>
                      {(selectedModelUnavailable || selectedModelPending) && (
                        <option value={selectedModel}>{selectedModelUnavailable
                          ? `已保存的模型已不在目录中：${selectedModel}`
                          : `已保存的模型：${selectedModel}`}</option>
                      )}
                      {provider?.models.map(option => <option key={option.model} value={option.model}>{option.displayName}</option>)}
                    </select>
                  </label>
                  <label>
                    <span>{profileOwner === 'claude-code' ? '思考强度' : '推理强度'}</span>
                    <select
                      aria-label={profileOwner === 'claude-code' ? 'Claude 思考强度' : 'Codex 推理强度'}
                      value={selectedEffort ?? 'auto'}
                      disabled={locked || provider === undefined || !provider.available
                        || (availableEfforts.length === 0 && selectedEffort === undefined)}
                      onChange={(event) => { chooseEffort(event.currentTarget.value) }}
                    >
                      <option value="auto">按任务推荐</option>
                      {(selectedEffortUnavailable || selectedEffortPending) && (
                        <option value={selectedEffort}>{selectedEffortUnavailable
                          ? `已保存的强度不受当前模型支持：${selectedEffort}`
                          : `已保存的强度：${selectedEffort}`}</option>
                      )}
                      {availableEfforts.map(effort => (
                        <option key={effort} value={effort}>
                          {physicalOperatorEffortLabel(effort, profileOwner)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {preference !== undefined && (
                    <button type="button" disabled={locked} onClick={() => { saveProfile(profileOwner) }}>
                      清除模型与强度偏好
                    </button>
                  )}
                  {provider === undefined
                    ? <p>正在读取当前执行端的原生订阅模型目录…</p>
                    : !provider.available
                      ? <p>当前连接的执行端不可用：{provider.unavailableReason ?? '订阅资格未通过'}</p>
                      : selectedModelUnavailable
                        ? <p>已保存的模型“{selectedModel}”已不在当前目录中；请选择可用模型或按任务推荐。</p>
                        : selectedEffortUnavailable
                          ? <p>已保存的强度“{selectedEffort}”不受当前模型支持；请选择可用强度或按任务推荐。</p>
                          : <p>{model?.displayName ?? '按任务推荐'}：{model?.description ?? '由系统按任务与配额选择。'}{model?.supportsAdaptiveThinking === true ? ' 支持原生自适应思考。' : ''}</p>}
                </div>
              )}
              {planSelected && (
                <div className="dshDesktopOperatorProfilePreferences" role="status">
                  <strong>Plan 与直接 Debate 不能同时执行</strong>
                  <small>Plan 需要由主模型提交计划并等待批准。请先退出 Plan 再启用 Debate；已启用 Debate 时请退出 Debate 后继续计划。</small>
                </div>
              )}
              {selectedMainModel === 'chatgpt-web' && (
                <div className="dshDesktopOperatorProfilePreferences" role="status">
                  <small>{webCoordinationReady
                    ? '工具协作模式允许通过 Custom MCP 使用 DSH 工具和 TaskGraph；网页模型和思考强度仍请在 ChatGPT 中设置。'
                    : '独立问答只接收文本，不访问 DSH 工作区文件或执行 TaskGraph；请先完成上方的 Custom MCP 协作设置。'}</small>
                </div>
              )}
              {orchestrationPreferences !== undefined && debatePreferences !== undefined && (
                <div className="dshDesktopOperatorProfilePreferences dshDesktopOperatorTaskGraphPreferences" data-page={page}>
                  <div>
                    <strong>{page === 'basic' ? '执行机制' : 'TaskGraph 高级调度'}</strong>
                    <small>{page === 'basic'
                      ? '标准关闭 RLM 和 Debate，但保留协作路由；RLM 只控制 TaskGraph 节点，Debate 接管直接消息。'
                      : taskGraphInactive
                        ? '当前路径不使用这些设置；已保存的 TaskGraph 偏好保留，当前不可编辑。'
                        : '仅在 TaskGraph 节点执行时使用，不决定普通聊天的回答模型。'}</small>
                  </div>
                  <label>
                    <span>执行机制</span>
                    <select
                      aria-label="执行机制"
                      value={orchestrationExecutionMechanism(orchestrationPreferences.rlm, debatePreferences.mode)}
                      disabled={locked}
                      onChange={(event) => {
                        chooseExecutionMechanism(event.currentTarget.value as OrchestrationExecutionMechanism)
                      }}
                    >
                      <option value="auto">{orchestrationExecutionMechanismLabel('auto')}</option>
                      <option value="standard">{orchestrationExecutionMechanismLabel('standard')}</option>
                      <option value="rlm" disabled={taskGraphInactive}>{orchestrationExecutionMechanismLabel('rlm')}</option>
                      <option value="debate" disabled={planSelected}>{orchestrationExecutionMechanismLabel('debate')}</option>
                    </select>
                  </label>
                  <label>
                    <span>自主闭环</span>
                    <select
                      aria-label="自主闭环策略"
                      value={orchestrationPreferences.autonomous}
                      disabled={locked || taskGraphInactive}
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
                      <option value="enabled" disabled={orchestrationPreferences.rlm === 'disabled'}>{orchestrationAutonomousModeLabel('enabled')}</option>
                      <option value="disabled">{orchestrationAutonomousModeLabel('disabled')}</option>
                    </select>
                  </label>
                  <label>
                    <span>持续 Harness</span>
                    <select
                      aria-label="持续 Harness 策略"
                      value={orchestrationPreferences.continualHarness}
                      disabled={locked || taskGraphInactive}
                      onChange={(event) => {
                        saveOrchestrationStrategy(
                          orchestrationPreferences.rlm,
                          orchestrationPreferences.autonomous,
                          event.currentTarget.value as ContinualHarnessMode,
                          orchestrationPreferences.optimization,
                        )
                      }}
                    >
                      <option value="auto">自动（当前工作区）</option>
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
                      disabled={locked || taskGraphInactive}
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
                      disabled={locked || taskGraphInactive}
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
                      disabled={locked || taskGraphInactive}
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
                  {orchestrationPreferences.rlm === 'disabled' && (
                    <p>自主闭环需要 RLM；请先在基础页选择自动或 RLM，再启用自主闭环。</p>
                  )}
                  <p>Codex 和 Claude Code 均使用原生订阅目录。系统按目标、健康与配额分配并行节点；模型策略表示偏好，不保证固定使用该模型。持续 Harness 仅用于允许知识上下文的节点；计费 API 只作最后兜底。</p>
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
    direct: '由当前主模型处理；仅在消息中明确要求时调用执行助手。',
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
