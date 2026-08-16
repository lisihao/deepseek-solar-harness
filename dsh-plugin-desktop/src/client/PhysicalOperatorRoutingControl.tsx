import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  PhysicalOperatorRoutingPolicy,
} from '@deepseek-ai/dsh-tool-physical-operator/client'

/** Command face injected by the Desktop client registration. */
export interface PhysicalOperatorRoutingInjected {
  /** Persist one Session routing policy through the host command boundary. */
  select: (policy: PhysicalOperatorRoutingPolicy) => Promise<string | null>
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
}: PhysicalOperatorRoutingControlProps) {
  const routing = useProjection('physicalOperatorRouting')
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)

  useEffect(() => () => { alive.current = false }, [])
  if (routing === undefined) return null

  const locked = session.removed || input.phase !== 'plain' || saving
  const currentLabel = physicalOperatorRoutingLabel(routing.currentValue)
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
      {error !== null && <span className="dshDesktopOperatorRoutingError" role="status" title={error}>策略更新失败</span>}
    </span>
  )
}
