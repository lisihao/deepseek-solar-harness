import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
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
  auto: '智能自动',
  direct: '仅当前模型',
  codex: 'Codex',
  'claude-code': 'Claude Code',
}

/** Stable Chinese display label for one host-owned routing value. */
export function physicalOperatorRoutingLabel(policy: PhysicalOperatorRoutingPolicy): string {
  return LABELS[policy]
}

/** Render the logged execution policy next to the ordinary model selector. */
export function PhysicalOperatorRoutingControl({
  useProjection,
  session,
  input,
  select,
  selectProfile,
}: PhysicalOperatorRoutingControlProps) {
  const routing = useProjection('physicalOperatorRouting')
  const [open, setOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [effortOpen, setEffortOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dashboard, setDashboard] = useState<DesktopResidentDashboard>()
  const alive = useRef(true)

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
  const profileProjection = useProjection('physicalOperatorProfiles')
  if (routing === undefined) return null

  const locked = session.removed || input.phase !== 'plain' || saving
  const currentLabel = physicalOperatorRoutingLabel(routing.currentValue)
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
  const choose = (id: string): void => {
    const policy = routing.options.find(option => option.value === id)?.value
    setOpen(false)
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
    setModelOpen(false)
    if (profileOwner === undefined) return
    const nextModel = id === 'auto' ? undefined : provider?.models.find(candidate => candidate.model === id)?.model
    const nextOption = nextModel === undefined ? undefined : provider?.models.find(candidate => candidate.model === nextModel)
    const nextEffort = selectedEffort !== undefined && nextOption?.supportedEfforts.includes(selectedEffort)
      ? selectedEffort
      : undefined
    saveProfile(profileOwner, nextModel, nextEffort as PhysicalOperatorProfileReasoningEffort | undefined)
  }
  const chooseEffort = (id: string): void => {
    setEffortOpen(false)
    if (profileOwner === undefined) return
    const nextEffort = id === 'auto' ? undefined : id as PhysicalOperatorProfileReasoningEffort
    saveProfile(profileOwner, selectedModel, nextEffort)
  }

  return (
    <span className="dshDesktopOperatorRoutingWrap">
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        selectedId={routing.currentValue}
        onSelect={choose}
        align="end"
        side="top"
        portal
        compact
        items={routing.options.map(option => ({
          id: option.value,
          label: (
            <span className="dshDesktopOperatorRoutingItem">
              <strong>{physicalOperatorRoutingLabel(option.value)}</strong>
              <small>{option.description}</small>
            </span>
          ),
        }))}
        anchor={(
          <button
            type="button"
            className="dshDesktopOperatorRoutingChip"
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={locked}
            title={error ?? '选择主模型处理任务时是否自动调用订阅态 Codex 或 Claude Code'}
            onClick={() => { setOpen(value => !value) }}
          >
            <span>算子 · {saving ? '保存中' : currentLabel}</span>
            <IconChevronDownOutline14 />
          </button>
        )}
      />
      {profileOwner !== undefined && (
        <Menu
          open={modelOpen}
          onClose={() => { setModelOpen(false) }}
          selectedId={selectedModel ?? 'auto'}
          onSelect={chooseModel}
          align="end"
          side="top"
          portal
          compact
          items={[
            {
              id: 'auto',
              label: (
                <span className="dshDesktopOperatorRoutingItem">
                  <strong>智能模型</strong><small>按任务复杂度从原生订阅目录选择</small>
                </span>
              ),
            },
            ...(provider?.models.map(option => ({
              id: option.model,
              label: (
                <span className="dshDesktopOperatorRoutingItem">
                  <strong>{option.displayName}</strong><small>{option.description}</small>
                </span>
              ),
            })) ?? []),
          ]}
          anchor={(
            <button
              type="button"
              className="dshDesktopOperatorRoutingChip"
              aria-haspopup="menu"
              aria-expanded={modelOpen}
              disabled={locked || provider === undefined}
              title={provider === undefined ? '正在读取原生订阅模型目录' : '选择 Resident Session 使用的原生模型'}
              onClick={() => { setModelOpen(value => !value) }}
            >
              <span>模型 · {selectedModel === undefined ? `智能（${model?.displayName ?? '读取中'}）` : model?.displayName ?? selectedModel}</span>
              <IconChevronDownOutline14 />
            </button>
          )}
        />
      )}
      {profileOwner !== undefined && (
        <Menu
          open={effortOpen}
          onClose={() => { setEffortOpen(false) }}
          selectedId={selectedEffort ?? 'auto'}
          onSelect={chooseEffort}
          align="end"
          side="top"
          portal
          compact
          items={[
            { id: 'auto', label: <span className="dshDesktopOperatorRoutingItem"><strong>智能强度</strong><small>按任务复杂度选择支持的推理等级</small></span> },
            ...((model?.supportedEfforts ?? profileProjection?.efforts ?? []).map(effort => ({
              id: effort,
              label: <span className="dshDesktopOperatorRoutingItem"><strong>{effort}</strong><small>{effortDescription(effort)}</small></span>,
            }))),
          ]}
          anchor={(
            <button
              type="button"
              className="dshDesktopOperatorRoutingChip"
              aria-haspopup="menu"
              aria-expanded={effortOpen}
              disabled={locked || provider === undefined || (model?.supportedEfforts.length ?? 0) === 0}
              title={(model?.supportedEfforts.length ?? 0) === 0 ? '这个模型不提供可调推理强度' : '选择 Resident Session 的推理或思考强度'}
              onClick={() => { setEffortOpen(value => !value) }}
            >
              <span>强度 · {selectedEffort ?? `智能（${model?.defaultEffort ?? '自动'}）`}</span>
              <IconChevronDownOutline14 />
            </button>
          )}
        />
      )}
      {error !== null && <span className="dshDesktopOperatorRoutingError" role="status" title={error}>策略更新失败</span>}
    </span>
  )
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
