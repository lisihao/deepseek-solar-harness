/**
 * Luna Vision Bridge settings section, browser half: edit the downstream
 * targets (provider/model pairs picked from the live model catalog) and the
 * bridge display name, save through the settings domain (`settings.update`
 * on the `luna-vision-bridge` namespace). The Host re-validates via
 * `resolveConfig` and applies the change live, so the model selector and the
 * models directory follow without a restart.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { ModelProviderGroup, SettingsNamespaceView } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  blankTarget, draftBlockers, draftFromValue, draftToPatch,
} from './draft.ts'
import type { LunaDraft, TargetDraft } from './draft.ts'

/** Registration-side business face for the section. */
export interface LunaSectionInjected {
  /** Wire face for reading/writing the namespace and the model catalog. */
  api: Pick<IApiClient, 'settings' | 'llm'>
}

/** Full component props: the settings-shell owner share plus this face. */
export type LunaSectionProps =
  PropsRuntime<'settings.section'>
  & InjectFace<LunaSectionInjected>

const NS = 'luna-vision-bridge'

/** Whether the id follows the current target and must be reset when retargeting. */
function isAutomaticBridgeModel(row: TargetDraft): boolean {
  const id = row.bridgeModel.trim()
  return id === '' || id === row.model.trim() || id === `${row.provider.trim()}-${row.model.trim()}`
}

/** Minimal inline styling (no CSS pipeline in the client bundle). */
const styles = {
  panel: { padding: '16px 20px', maxWidth: '720px' },
  hint: { color: 'var(--ds-color-text-2, #6b7280)', fontSize: '13px', lineHeight: 1.7, marginTop: 0 },
  field: { margin: '14px 0' },
  label: { display: 'block', fontSize: '13px', fontWeight: 600, marginBottom: '6px' },
  input: {
    width: '100%', boxSizing: 'border-box', padding: '7px 10px', borderRadius: '8px',
    border: '1px solid var(--ds-color-border, #d1d5db)', background: 'var(--ds-color-bg, #fff)',
    color: 'var(--ds-color-text, #111827)', fontSize: '13px',
  } as const,
  row: {
    display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: '10px',
    marginBottom: '8px', alignItems: 'center',
  } as const,
  rowName: { marginBottom: '4px' } as const,
  advanced: { marginBottom: '14px' } as const,
  remove: {
    padding: '6px 12px', borderRadius: '8px', border: '1px solid var(--ds-color-border, #d1d5db)',
    background: 'transparent', cursor: 'pointer', fontSize: '13px', whiteSpace: 'nowrap',
  } as const,
  actions: { display: 'flex', gap: '10px', marginTop: '16px' },
  button: {
    padding: '8px 16px', borderRadius: '8px', border: '1px solid var(--ds-color-border, #d1d5db)',
    background: 'var(--ds-color-bg, #fff)', cursor: 'pointer', fontSize: '13px',
  } as const,
  primary: {
    padding: '8px 16px', borderRadius: '8px', border: '1px solid transparent',
    background: 'var(--ds-color-primary, #2563eb)', color: '#fff', cursor: 'pointer', fontSize: '13px',
  } as const,
  error: { color: 'var(--ds-color-danger, #dc2626)', fontSize: '13px' },
  success: { color: 'var(--ds-color-success, #15803d)', fontSize: '13px' },
  select: {
    width: '100%', boxSizing: 'border-box', padding: '7px 10px', borderRadius: '8px',
    border: '1px solid var(--ds-color-border, #d1d5db)', background: 'var(--ds-color-bg, #fff)',
    color: 'var(--ds-color-text, #111827)', fontSize: '13px',
  } as const,
  details: { fontSize: '13px' },
  summary: { cursor: 'pointer', color: 'var(--ds-color-text-2, #6b7280)', marginBottom: '6px' },
}

/** The settings section rendering the downstream-target editor. */
export function LunaSection(props: LunaSectionProps): ReactNode {
  const { api } = props
  const [namespace, setNamespace] = useState<SettingsNamespaceView | undefined>(undefined)
  const [catalog, setCatalog] = useState<readonly ModelProviderGroup[]>([])
  const [catalogState, setCatalogState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [writable, setWritable] = useState<boolean | undefined>(undefined)
  const [draft, setDraft] = useState<LunaDraft>({ providerName: '', targets: [] })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  const describe = async (syncDraft: boolean): Promise<boolean> => {
    const response = await api.settings.describe({})
    if (!response.result.ok) {
      setError(response.result.error.message)
      setWritable(false)
      return false
    }
    const found = response.result.value.namespaces.find(view => view.ns === NS)
    if (found === undefined) {
      setError(`设置段 ${NS} 尚未注册`)
      setWritable(false)
      return false
    }
    setNamespace(found)
    setWritable(response.result.value.writable)
    if (syncDraft) setDraft(draftFromValue(found.value))
    setError(undefined)
    return true
  }

  useEffect(() => {
    let stale = false
    void describe(true).catch((cause: unknown) => {
      if (!stale) {
        setError(cause instanceof Error ? cause.message : String(cause))
        setWritable(false)
      }
    })
    // The model catalog powers the provider/model pickers; a catalog failure
    // or an empty catalog degrades the pickers to manual inputs, never the
    // section.
    void api.llm.models({}).then((response) => {
      if (stale) return
      if (response.result.ok) {
        setCatalog(response.result.value.groups)
        setCatalogState('ready')
      } else {
        setCatalogState('failed')
      }
    }).catch(() => {
      if (!stale) setCatalogState('failed')
    })
    return () => { stale = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- describe is stable per api face
  }, [api])

  const writeDisabled = busy || writable === false || namespace === undefined

  /** Downstream candidates: the bridge provider itself is not a valid target. */
  const downstreamCatalog = catalog.filter(group => group.id !== NS)

  /** Models offered by one provider, for its row's model picker. */
  const modelsOf = (provider: string): readonly { id: string; name: string }[] => (
    catalog.find(group => group.id === provider)?.models ?? []
  )

  /** The display-name placeholder the Host would default to for one row. */
  const defaultNameOf = (row: TargetDraft): string => (
    row.model.trim() === '' ? '' : `${row.model.trim()} + Luna`
  )

  const setRow = (index: number, key: keyof TargetDraft, value: string): void => {
    setNotice(undefined)
    setDraft(current => ({
      ...current,
      targets: current.targets.map((row, i) => (
        i === index
          ? key === 'provider'
            ? {
                ...row,
                provider: value,
                model: '',
                name: '',
                // The zero-config target carries the stable
                // `deepseek-v4-flash` alias. Once the target changes that
                // alias is no longer truthful, so return to generated ids.
                bridgeModel: isAutomaticBridgeModel(row) ? '' : row.bridgeModel,
              }
            : key === 'model'
              ? {
                  ...row,
                  model: value,
                  bridgeModel: isAutomaticBridgeModel(row) ? '' : row.bridgeModel,
                }
              : { ...row, [key]: value }
          : row
      )),
    }))
  }
  const addRow = (): void => {
    setNotice(undefined)
    setDraft(current => ({ ...current, targets: [...current.targets, blankTarget()] }))
  }
  const removeRow = (index: number): void => {
    setNotice(undefined)
    setDraft(current => ({
      ...current,
      targets: current.targets.filter((_, i) => i !== index),
    }))
  }

  const blockers = draftBlockers(draft)
  const save = async (): Promise<void> => {
    if (namespace === undefined || blockers.length > 0 || writeDisabled) return
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    try {
      const response = await api.settings.update({
        ns: NS,
        patch: draftToPatch(draft),
        expectedRevision: namespace.revision,
      })
      if (!response.result.ok) {
        if (response.result.error.code === 'settings-conflict') {
          // Refresh the revision so a retry can land, while keeping the local
          // draft so the user's edits are not silently discarded.
          const refreshed = await describe(false)
          setError(refreshed
            ? '设置已被其他窗口修改，已刷新最新值，请检查后重新保存'
            : '设置已被其他窗口修改，但无法重新加载')
          return
        }
        setError(response.result.error.message)
        return
      }
      setNamespace(response.result.value)
      setDraft(draftFromValue(response.result.value.value))
      setError(undefined)
      setNotice('设置已保存并即时生效')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const reset = async (): Promise<void> => {
    if (namespace === undefined || writeDisabled) return
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    try {
      const response = await api.settings.mutate({
        ns: NS,
        ops: [
          { op: 'unset', path: ['providerName'] },
          { op: 'unset', path: ['targets'] },
        ],
        expectedRevision: namespace.revision,
      })
      if (!response.result.ok) {
        if (response.result.error.code === 'settings-conflict') {
          const refreshed = await describe(false)
          setError(refreshed
            ? '设置已被其他窗口修改，已刷新最新值，请重试'
            : '设置已被其他窗口修改，但无法重新加载')
          return
        }
        setError(response.result.error.message)
        return
      }
      setNamespace(response.result.value)
      setDraft(draftFromValue(response.result.value.value))
      setError(undefined)
      setNotice('已恢复默认设置并即时生效')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={styles.panel}>
      <p style={styles.hint}>
        识图阶段默认使用当前用户已登录的 Codex 订阅与 gpt-5.6-luna，不使用 OpenAI API key；下方选择的是接收转写文本并生成最终回答的下游模型，
        其调用按该 provider 自己的计费方式执行。未配置时下游为 DeepSeek V4 Flash（deepseek-official / deepseek-v4-flash）。
      </p>
      <div style={styles.field}>
        <label style={styles.label} htmlFor="luna-provider-name">Provider 显示名</label>
        <input
          id="luna-provider-name"
          style={styles.input}
          type="text"
          value={draft.providerName}
          placeholder="Luna Vision Bridge"
          disabled={writeDisabled}
          onChange={event => {
            setNotice(undefined)
            setDraft(current => ({ ...current, providerName: event.target.value }))
          }}
        />
      </div>
      <div style={styles.field}>
        <span style={styles.label}>下游模型</span>
        {draft.targets.map((row, index) => (
          <div key={index}>
            <div style={styles.row}>
              {catalog.length === 0
                ? (
                  <input
                    style={styles.select}
                    type="text"
                    aria-label={`第 ${index + 1} 行 provider`}
                    placeholder={catalogState === 'loading' ? '加载模型目录中…' : '模型目录不可用，请手动输入 provider…'}
                    value={row.provider}
                    disabled={writeDisabled}
                    onChange={event => setRow(index, 'provider', event.target.value)}
                  />
                )
                : (
                  <select
                    style={styles.select}
                    aria-label={`第 ${index + 1} 行 provider`}
                    value={row.provider}
                    disabled={writeDisabled}
                    onChange={event => setRow(index, 'provider', event.target.value)}
                  >
                    <option value="">选择 provider…</option>
                    {downstreamCatalog.map(group => (
                      <option key={group.id} value={group.id}>{group.name}</option>
                    ))}
                  </select>
                )}
              {row.provider !== '' && modelsOf(row.provider).length === 0
                ? (
                  <input
                    style={styles.select}
                    type="text"
                    aria-label={`第 ${index + 1} 行 model`}
                    placeholder="该 provider 无模型目录，请手动输入 model…"
                    value={row.model}
                    disabled={writeDisabled}
                    onChange={event => setRow(index, 'model', event.target.value)}
                  />
                )
                : (
                  <select
                    style={styles.select}
                    aria-label={`第 ${index + 1} 行 model`}
                    value={row.model}
                    disabled={writeDisabled || row.provider === ''}
                    onChange={event => setRow(index, 'model', event.target.value)}
                  >
                    <option value="">选择模型…</option>
                    {modelsOf(row.provider).map(model => (
                      <option key={model.id} value={model.id}>{model.name}</option>
                    ))}
                  </select>
                )}
              <button
                type="button"
                style={styles.remove}
                disabled={writeDisabled}
                onClick={() => removeRow(index)}
              >
                删除
              </button>
            </div>
            <div style={styles.rowName}>
              <input
                style={styles.input}
                type="text"
                placeholder={`显示名（可选，默认 ${defaultNameOf(row) || '模型 + Luna'}）`}
                aria-label={`第 ${index + 1} 行显示名`}
                value={row.name}
                disabled={writeDisabled}
                onChange={event => setRow(index, 'name', event.target.value)}
              />
            </div>
            <details style={styles.advanced}>
              <summary style={styles.summary}>高级</summary>
              <input
                style={styles.input}
                type="text"
                placeholder={`桥接模型 id（留空自动生成 ${row.provider || 'provider'}-${row.model || 'model'}）`}
                aria-label={`第 ${index + 1} 行桥接模型 id`}
                value={row.bridgeModel}
                disabled={writeDisabled}
                onChange={event => setRow(index, 'bridgeModel', event.target.value)}
              />
            </details>
          </div>
        ))}
        <button type="button" style={styles.button} disabled={writeDisabled} onClick={addRow}>
          ＋ 添加下游模型
        </button>
      </div>
      {writable === false && namespace !== undefined
        ? <p style={styles.error}>当前设置只读，无法修改</p>
        : null}
      {blockers.length > 0
        ? <p style={styles.error}>{blockers.join('；')}</p>
        : null}
      {error === undefined ? null : <p style={styles.error}>{error}</p>}
      {notice === undefined ? null : <p role="status" style={styles.success}>{notice}</p>}
      <div style={styles.actions}>
        <button
          type="button"
          style={styles.primary}
          disabled={writeDisabled || blockers.length > 0}
          onClick={() => { void save() }}
        >
          {busy ? '保存中…' : '保存'}
        </button>
        <button type="button" style={styles.button} disabled={writeDisabled} onClick={() => { void reset() }}>
          恢复默认
        </button>
      </div>
    </div>
  )
}
