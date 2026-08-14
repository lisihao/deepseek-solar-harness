/** Multi-instance configuration surface contributed to Settings → Plugins. */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { RemoteModulesConfig } from '../contract.ts'
import {
  draftRemoteModules, validateRemoteModuleDrafts,
  type RemoteModuleDraft, type RemoteModuleDraftError, type RemoteModuleDraftField,
} from './settings-draft.ts'
import type { RemoteModulesSettingsKey } from './settings-locales.ts'
import css from './RemoteModulesSettings.module.css'

/** Settings scope injected by the browser plugin registration. */
export interface RemoteModulesSettingsInjected {
  scope: SettingsScope<RemoteModulesConfig>
}

/** Renderer props composed by the plugin-settings tab slot. */
export type RemoteModulesSettingsProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.remoteModules'>
  & InjectFace<RemoteModulesSettingsInjected>

function same(value: unknown, expected: unknown): boolean {
  return JSON.stringify(value) === JSON.stringify(expected)
}

/** Render editable module rows and persist the complete instances array. */
export function RemoteModulesSettings({ scope, t }: RemoteModulesSettingsProps) {
  const snapshot = useSyncExternalStore(
    listener => scope.subscribe(listener),
    () => scope.getSnapshot(),
  )
  const nextKey = useRef(0)
  const key = (): string => `remote-module-${String(++nextKey.current)}`
  const [rows, setRows] = useState<RemoteModuleDraft[]>([])
  const [sourceRevision, setSourceRevision] = useState<number>()
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (snapshot.status !== 'ready' || snapshot.value === undefined || dirty) return
    setRows(draftRemoteModules(snapshot.value.instances, key))
    setSourceRevision(snapshot.revision)
  }, [dirty, snapshot.revision, snapshot.status, snapshot.value])

  if (snapshot.status === 'loading') return <p className={css.status}>{t('loading')}</p>
  if (snapshot.status !== 'ready' || snapshot.value === undefined) {
    return <p className={css.status}>{t('unavailable')}</p>
  }
  const acceptedConfig = snapshot.value

  const validation = validateRemoteModuleDrafts(rows)
  const conflict = dirty && sourceRevision !== undefined && snapshot.revision !== undefined
    && sourceRevision !== snapshot.revision && !saving
  const mutate = (rowKey: string, field: RemoteModuleDraftField, value: string): void => {
    setRows(current => current.map(row => row.key === rowKey ? { ...row, [field]: value } : row))
    setDirty(true)
    setSaved(false)
    setFailed(false)
  }
  const discard = (): void => {
    setRows(draftRemoteModules(acceptedConfig.instances, key))
    setSourceRevision(snapshot.revision)
    setDirty(false)
    setSaved(false)
    setFailed(false)
  }
  const save = async (): Promise<void> => {
    const config = validation.config
    if (config === undefined || !dirty || conflict || saving) return
    setSaving(true)
    setSaved(false)
    setFailed(false)
    await scope.set('instances', config.instances)
    const accepted = scope.getSnapshot()
    const landed = same((accepted.user as Record<string, unknown> | undefined)?.instances, config.instances)
    setSaving(false)
    setFailed(!landed)
    if (!landed) return
    setRows(draftRemoteModules(accepted.value?.instances ?? config.instances, key))
    setSourceRevision(accepted.revision)
    setDirty(false)
    setSaved(true)
  }
  const reset = async (): Promise<void> => {
    if (saving || !snapshot.writable) return
    setSaving(true)
    setSaved(false)
    setFailed(false)
    await scope.unset('instances')
    const accepted = scope.getSnapshot()
    const landed = !Object.hasOwn(accepted.user as object | undefined ?? {}, 'instances')
    setSaving(false)
    setFailed(!landed)
    if (!landed || accepted.value === undefined) return
    setRows(draftRemoteModules(accepted.value.instances, key))
    setSourceRevision(accepted.revision)
    setDirty(false)
    setSaved(true)
  }
  const message = (error: RemoteModuleDraftError | undefined): string | undefined =>
    error === undefined ? undefined : t(error satisfies RemoteModulesSettingsKey)

  return (
    <div className={css.section}>
      <header className={css.intro}>
        <div>
          <h3>{t('title')}</h3>
          <p>{t('intro')}</p>
        </div>
        <button
          type="button"
          className={css.add}
          disabled={!snapshot.writable || saving || conflict}
          onClick={() => {
            const number = rows.length + 1
            setRows(current => [...current, {
              key: key(), id: `web-page-${String(number)}`, label: `Web page ${String(number)}`,
              url: 'http://127.0.0.1:3000/', relayPort: '0', order: String(number * 100),
            }])
            setDirty(true)
            setSaved(false)
            setFailed(false)
          }}
        >{t('add')}</button>
      </header>
      <p className={css.restart}>{t('restartNotice')}</p>
      {!snapshot.writable ? <p className={css.warning}>{t('readOnly')}</p> : null}
      {conflict ? <p className={css.warning} role="alert">{t('conflict')}</p> : null}
      <div className={css.rows}>
        {rows.map((row, index) => {
          const errors = validation.errors[row.key] ?? {}
          const field = (
            name: RemoteModuleDraftField,
            label: RemoteModulesSettingsKey,
            hint: RemoteModulesSettingsKey,
            numeric = false,
          ) => {
            const error = message(errors[name])
            const inputId = `${row.key}-${name}`
            const hintId = `${inputId}-hint`
            return (
              <div className={name === 'url' ? css.fieldWide : css.field}>
                <label htmlFor={inputId}>{t(label)}</label>
                <input
                  id={inputId}
                  value={row[name]}
                  inputMode={numeric ? 'numeric' : undefined}
                  spellCheck={false}
                  disabled={!snapshot.writable || saving || conflict}
                  aria-describedby={hintId}
                  aria-invalid={error === undefined ? undefined : true}
                  onChange={(event) => { mutate(row.key, name, event.target.value) }}
                />
                <small id={hintId} className={error === undefined ? css.hint : css.error}>{error ?? t(hint)}</small>
              </div>
            )
          }
          return (
            <section key={row.key} className={css.row}>
              <div className={css.rowHeader}>
                <strong>{`${t('module')} ${String(index + 1)}${row.label.trim() === '' ? '' : ` · ${row.label.trim()}`}`}</strong>
                <button
                  type="button"
                  className={css.remove}
                  disabled={rows.length === 1 || !snapshot.writable || saving || conflict}
                  onClick={() => {
                    setRows(current => current.filter(candidate => candidate.key !== row.key))
                    setDirty(true)
                    setSaved(false)
                    setFailed(false)
                  }}
                >{t('delete')}</button>
              </div>
              <div className={css.fields}>
                {field('id', 'id', 'idHint')}
                {field('label', 'label', 'required')}
                {field('url', 'url', 'urlHint')}
                {field('relayPort', 'relayPort', 'relayPortHint', true)}
                {field('order', 'order', 'orderHint', true)}
              </div>
            </section>
          )
        })}
      </div>
      <footer className={css.footer}>
        <span className={failed ? css.error : css.success} role="status">
          {failed ? t('saveFailed') : saved ? t('saved') : ''}
        </span>
        <button type="button" className={css.secondary} disabled={!snapshot.writable || saving} onClick={() => { void reset() }}>{t('reset')}</button>
        <button type="button" className={css.secondary} disabled={!dirty || saving} onClick={discard}>{t('discard')}</button>
        <button
          type="button"
          className={css.save}
          disabled={!snapshot.writable || !dirty || validation.config === undefined || conflict || saving}
          onClick={() => { void save() }}
        >{t(saving ? 'saving' : 'save')}</button>
      </footer>
    </div>
  )
}
