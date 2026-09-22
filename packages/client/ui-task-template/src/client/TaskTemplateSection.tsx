/** Task-template catalog, editor, and saved-template preview. */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  TaskAttributes,
  TaskTemplateMatch,
  TaskTemplatePersonalization,
  TaskTemplateSelection,
} from '@deepseek-ai/dsh-task-template'
import type {
  TaskTemplateRpcChannel,
  TaskTemplateRpcSnapshotV1,
  TaskTemplateView,
} from '@deepseek-ai/dsh-task-template-rpc/shared'
import type { TaskTemplateLocaleKey } from './locales.ts'
import styles from './TaskTemplateSection.module.css'

const TASK_TEMPLATE_RPC_CHANNEL = '/task-templates' satisfies TaskTemplateRpcChannel

/** Business values supplied by the browser plugin registration. */
export interface TaskTemplateSectionInjected {
  readonly connection: ConnectionHandle
  readonly t: (key: TaskTemplateLocaleKey) => string
}

/** Complete props composed for the task-template settings slot. */
export type TaskTemplateSectionProps =
  PropsRuntime<'settings.section'>
  & InjectFace<TaskTemplateSectionInjected>

interface Draft {
  id: string
  name: string
  rank: string
  method: string
  enabled: boolean
  taskTypes: string
  domains: string
  objectiveKeywords: string
  outputFormats: string
  requiredTools: string
  requiredSkills: string
  operators: string
  languages: string
  riskLevels: string
  priorities: string
  preferences: string
  memory: string
}

interface PreviewDraft {
  taskType: string
  domain: string
  objective: string
  outputFormat: string
  language: string
}

interface MatchField {
  readonly field: keyof Pick<
    Draft,
    | 'taskTypes'
    | 'domains'
    | 'objectiveKeywords'
    | 'outputFormats'
    | 'requiredTools'
    | 'requiredSkills'
    | 'operators'
    | 'languages'
    | 'riskLevels'
    | 'priorities'
  >
  readonly label: TaskTemplateLocaleKey
  readonly hint: TaskTemplateLocaleKey
}

const MATCH_FIELDS: readonly MatchField[] = [
  { field: 'taskTypes', label: 'taskTypes', hint: 'taskTypesHint' },
  { field: 'domains', label: 'domains', hint: 'domainsHint' },
  { field: 'objectiveKeywords', label: 'keywords', hint: 'keywordsHint' },
  { field: 'outputFormats', label: 'outputFormats', hint: 'outputFormatsHint' },
  { field: 'operators', label: 'operators', hint: 'operatorsHint' },
  { field: 'requiredTools', label: 'tools', hint: 'toolsHint' },
  { field: 'requiredSkills', label: 'skills', hint: 'skillsHint' },
  { field: 'languages', label: 'languages', hint: 'languagesHint' },
  { field: 'riskLevels', label: 'risks', hint: 'risksHint' },
  { field: 'priorities', label: 'priorities', hint: 'prioritiesHint' },
]

const EMPTY: Draft = {
  id: '',
  name: '',
  rank: '0',
  method: '',
  enabled: false,
  taskTypes: '',
  domains: '',
  objectiveKeywords: '',
  outputFormats: '',
  requiredTools: '',
  requiredSkills: '',
  operators: '',
  languages: '',
  riskLevels: '',
  priorities: '',
  preferences: '',
  memory: '',
}

function joined(values: readonly string[] | undefined): string {
  return values?.join(', ') ?? ''
}

function draftOf(template: TaskTemplateView): Draft {
  return {
    id: template.id,
    name: template.name,
    rank: String(template.rank),
    method: template.method,
    enabled: template.enabled,
    taskTypes: joined(template.match.taskTypes),
    domains: joined(template.match.domains),
    objectiveKeywords: joined(template.match.objectiveKeywords),
    outputFormats: joined(template.match.outputFormats),
    requiredTools: joined(template.match.requiredTools),
    requiredSkills: joined(template.match.requiredSkills),
    operators: joined(template.match.operators),
    languages: joined(template.match.languages),
    riskLevels: joined(template.match.riskLevels),
    priorities: joined(template.match.priorities),
    preferences: template.personalization?.preferences ?? '',
    memory: template.personalization?.memory ?? '',
  }
}

function list(value: string): string[] | undefined {
  const values = [...new Set(value.split(',').map(entry => entry.trim()).filter(Boolean))]
  return values.length === 0 ? undefined : values
}

function matchOf(draft: Draft): TaskTemplateMatch {
  const taskTypes = list(draft.taskTypes)
  const domains = list(draft.domains)
  const objectiveKeywords = list(draft.objectiveKeywords)
  const outputFormats = list(draft.outputFormats)
  const requiredTools = list(draft.requiredTools)
  const requiredSkills = list(draft.requiredSkills)
  const operators = list(draft.operators)
  const languages = list(draft.languages)
  const riskLevels = list(draft.riskLevels) as TaskTemplateMatch['riskLevels']
  const priorities = list(draft.priorities) as TaskTemplateMatch['priorities']
  return {
    ...taskTypes === undefined ? {} : { taskTypes },
    ...domains === undefined ? {} : { domains },
    ...objectiveKeywords === undefined ? {} : { objectiveKeywords },
    ...outputFormats === undefined ? {} : { outputFormats },
    ...requiredTools === undefined ? {} : { requiredTools },
    ...requiredSkills === undefined ? {} : { requiredSkills },
    ...operators === undefined ? {} : { operators },
    ...languages === undefined ? {} : { languages },
    ...riskLevels === undefined ? {} : { riskLevels },
    ...priorities === undefined ? {} : { priorities },
  }
}

function personalOf(draft: Draft): TaskTemplatePersonalization | null {
  const preferences = draft.preferences.trim()
  const memory = draft.memory.trim()
  return preferences === '' && memory === '' ? null : {
    ...preferences === '' ? {} : { preferences },
    ...memory === '' ? {} : { memory },
  }
}

async function call<Result>(
  connection: ConnectionHandle,
  endpoint: string,
  payload: unknown,
): Promise<Result> {
  const response = await connection.rpc.call(TASK_TEMPLATE_RPC_CHANNEL, endpoint, payload)
  if (!response.ok) throw new Error(response.error.message)
  return response.value as Result
}

function sameMethod(template: TaskTemplateView, draft: Draft): boolean {
  return template.name === draft.name.trim()
    && template.rank === Number(draft.rank)
    && template.method === draft.method
    && MATCH_FIELDS.every(({ field }) =>
      JSON.stringify(template.match[field]) === JSON.stringify(list(draft[field])))
}

function sameDraft(template: TaskTemplateView, draft: Draft): boolean {
  const personal = personalOf(draft)
  return sameMethod(template, draft)
    && template.enabled === draft.enabled
    && template.personalization?.preferences === personal?.preferences
    && template.personalization?.memory === personal?.memory
}

function previewDraftOf(template: TaskTemplateView): PreviewDraft {
  return {
    taskType: template.match.taskTypes?.[0] ?? 'general',
    domain: template.match.domains?.[0] ?? 'general',
    objective: template.match.objectiveKeywords?.join(' ') ?? template.name,
    outputFormat: template.match.outputFormats?.[0] ?? 'text',
    language: template.match.languages?.[0] ?? 'en',
  }
}

function previewAttributes(template: TaskTemplateView, draft: PreviewDraft): TaskAttributes {
  return {
    taskType: draft.taskType.trim(),
    domain: draft.domain.trim(),
    objective: draft.objective.trim(),
    outputFormat: draft.outputFormat.trim(),
    riskLevel: template.match.riskLevels?.[0] ?? 'low',
    tools: [...(template.match.requiredTools ?? [])],
    skills: [...(template.match.requiredSkills ?? [])],
    operators: [...(template.match.operators ?? [])],
    language: draft.language.trim(),
    priority: template.match.priorities?.[0] ?? 'normal',
  }
}

function templateFrom(
  snapshot: TaskTemplateRpcSnapshotV1,
  id: string,
  missingMessage: string,
): TaskTemplateView {
  const template = snapshot.templates.find(item => item.id === id)
  if (template === undefined) throw new Error(missingMessage)
  return template
}

/**
 * Render the task-template catalog and editor.
 * @param props - slot runtime props and registration-owned services.
 * @returns the settings section.
 */
export function TaskTemplateSection({ connection, t }: TaskTemplateSectionProps): ReactNode {
  const [loaded, setLoaded] = useState<{
    readonly connection: ConnectionHandle
    readonly snapshot: TaskTemplateRpcSnapshotV1
  }>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [selectedId, setSelectedId] = useState<string>()
  const [draft, setDraft] = useState<Draft>()
  const [saving, setSaving] = useState(false)
  const authorityEpoch = useRef(0)
  const snapshot = loaded?.connection === connection ? loaded.snapshot : undefined
  const selected = useMemo(
    () => snapshot?.templates.find(item => item.id === selectedId),
    [snapshot, selectedId],
  )
  const load = useCallback((): void => {
    const epoch = ++authorityEpoch.current
    setLoaded(undefined)
    setSelectedId(undefined)
    setDraft(undefined)
    setSaving(false)
    setError(undefined)
    setNotice(undefined)
    void call<TaskTemplateRpcSnapshotV1>(connection, 'list', {}).then(
      (next) => {
        if (epoch === authorityEpoch.current) setLoaded({ connection, snapshot: next })
      },
      (cause: unknown) => {
        if (epoch === authorityEpoch.current) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      },
    )
  }, [connection])
  useEffect(() => {
    load()
    return () => { authorityEpoch.current += 1 }
  }, [load])

  const edit = (template: TaskTemplateView): void => {
    setSelectedId(template.id)
    setDraft(draftOf(template))
    setError(undefined)
    setNotice(undefined)
  }
  const create = (): void => {
    setSelectedId(undefined)
    setDraft({ ...EMPTY })
    setError(undefined)
    setNotice(undefined)
  }
  const set = (field: keyof Draft, value: string | boolean): void => {
    setDraft((current) => {
      /* v8 ignore next -- Editor controls unmount in the same render that clears the draft. */
      if (current === undefined) return undefined
      return { ...current, [field]: value }
    })
    setNotice(undefined)
  }
  const save = async (): Promise<void> => {
    /* v8 ignore next -- the editor and enabled Save control require a loaded draft; the guard contains duplicate gestures. */
    if (draft === undefined || snapshot === undefined || saving) return
    setSaving(true)
    setError(undefined)
    setNotice(undefined)
    const id = selected?.id ?? draft.id.trim()
    const epoch = authorityEpoch.current
    let next = snapshot
    const progress = { committed: false }
    const mutate = async (endpoint: string, payload: unknown): Promise<void> => {
      next = await call<TaskTemplateRpcSnapshotV1>(connection, endpoint, payload)
      if (epoch !== authorityEpoch.current) throw new Error('task-template authority changed during save')
      progress.committed = true
      setLoaded({ connection, snapshot: next })
      setSelectedId(id)
    }
    try {
      if (selected === undefined) {
        await mutate('create', {
          draft: {
            id,
            name: draft.name.trim(),
            rank: Number(draft.rank),
            method: draft.method,
            match: matchOf(draft),
          },
        })
      } else if (!sameMethod(selected, draft)) {
        await mutate('update', {
          id,
          patch: {
            name: draft.name.trim(),
            rank: Number(draft.rank),
            method: draft.method,
            match: matchOf(draft),
          },
        })
      }
      let accepted = templateFrom(next, id, t('saveMissing'))
      if (accepted.enabled !== draft.enabled) {
        await mutate('set-enabled', { id, enabled: draft.enabled })
        accepted = templateFrom(next, id, t('saveMissing'))
      }
      const personal = personalOf(draft)
      if (accepted.personalization?.preferences !== personal?.preferences
        || accepted.personalization?.memory !== personal?.memory) {
        await mutate('personalize', { id, personalization: personal })
        accepted = templateFrom(next, id, t('saveMissing'))
      }
      setDraft(draftOf(accepted))
      setNotice(t('saved'))
    } catch (cause) {
      if (epoch !== authorityEpoch.current) return
      const detail = cause instanceof Error ? cause.message : String(cause)
      setError(progress.committed ? `${t('partialSaveFailed')} ${detail}` : detail)
    } finally {
      if (epoch === authorityEpoch.current) setSaving(false)
    }
  }
  const remove = (template: TaskTemplateView): void => {
    if (!window.confirm(t('confirmDelete'))) return
    const epoch = authorityEpoch.current
    setError(undefined)
    setNotice(undefined)
    void call<TaskTemplateRpcSnapshotV1>(connection, 'delete', { id: template.id }).then((next) => {
      if (epoch !== authorityEpoch.current) return
      setLoaded({ connection, snapshot: next })
      if (selectedId === template.id) {
        setSelectedId(undefined)
        setDraft(undefined)
      }
      setNotice(t('deleted'))
    }, (cause: unknown) => {
      if (epoch === authorityEpoch.current) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    })
  }
  const cancel = (): void => {
    setSelectedId(undefined)
    setDraft(undefined)
    setError(undefined)
    setNotice(undefined)
  }

  if (error !== undefined && snapshot === undefined) {
    return <main className={styles.page}>
      <h1>{t('title')}</h1>
      <p className={styles.error} role="alert">{t('loadFailed')}: {error}</p>
      <button type="button" className={styles.secondary} onClick={load}>{t('retry')}</button>
    </main>
  }
  return <main className={styles.page} aria-busy={snapshot === undefined || saving}>
    <header className={styles.hero}>
      <div><h1>{t('title')}</h1><p>{t('intro')}</p></div>
      <button
        type="button"
        className={styles.primary}
        disabled={snapshot === undefined || saving}
        onClick={create}
      >{t('add')}</button>
    </header>
    <div className={styles.messages} aria-live="polite">
      {error === undefined ? null : <p className={styles.error} role="alert">{error}</p>}
      {notice === undefined ? null : <p className={styles.notice} role="status">{notice}</p>}
    </div>
    <div className={styles.layout}>
      <section className={styles.catalog} aria-labelledby="task-template-catalog-title">
        <h2 id="task-template-catalog-title">{t('catalogTitle')}</h2>
        {snapshot === undefined ? <p className={styles.empty} role="status">{t('loading')}</p> : null}
        {snapshot?.templates.length === 0 ? <p className={styles.empty}>{t('empty')}</p> : null}
        <ul className={styles.cards}>
          {snapshot?.templates.map(template => <li key={template.id}>
            <article className={styles.card} data-active={selectedId === template.id || undefined}>
              <button
                type="button"
                className={styles.cardBody}
                disabled={saving}
                aria-pressed={selectedId === template.id}
                aria-label={`${t('editTitle')}: ${template.name}`}
                onClick={() => { edit(template) }}
              >
                <span><strong>{template.name}</strong><code>{template.id}</code></span>
                <small>{t('version')} {template.version} · {template.history.length} {t('history')}</small>
              </button>
              <span className={template.enabled ? styles.on : styles.off}>
                {template.enabled ? t('enabled') : t('disabled')}
              </span>
              <button
                type="button"
                className={styles.danger}
                disabled={saving}
                aria-label={`${t('remove')}: ${template.name}`}
                onClick={() => { remove(template) }}
              >{t('remove')}</button>
            </article>
          </li>)}
        </ul>
      </section>
      {draft === undefined || snapshot === undefined ? null : <Editor
        draft={draft}
        existing={selected}
        variables={snapshot.variables}
        saving={saving}
        connection={connection}
        t={t}
        set={set}
        save={save}
        cancel={cancel}
      />}
    </div>
  </main>
}

function Editor({ draft, existing, variables, saving, connection, t, set, save, cancel }: {
  draft: Draft
  existing: TaskTemplateView | undefined
  variables: TaskTemplateRpcSnapshotV1['variables']
  saving: boolean
  connection: ConnectionHandle
  t: TaskTemplateSectionInjected['t']
  set: (field: keyof Draft, value: string | boolean) => void
  save: () => Promise<void>
  cancel: () => void
}): ReactNode {
  const prefix = useId()
  const canSave = draft.id.trim() !== ''
    && draft.name.trim() !== ''
    && draft.method.trim() !== ''
    && draft.rank.trim() !== ''
    && Number.isFinite(Number(draft.rank))
  const dirty = existing === undefined || !sameDraft(existing, draft)
  const textField = (
    field: MatchField['field'],
    label: TaskTemplateLocaleKey,
    hint: TaskTemplateLocaleKey,
  ): ReactNode => {
    const id = `${prefix}-${field}`
    const hintId = `${id}-hint`
    return <div className={styles.field}>
      <label htmlFor={id}>{t(label)}</label>
      <input
        id={id}
        value={draft[field]}
        disabled={saving}
        spellCheck={false}
        aria-describedby={hintId}
        onChange={(event) => { set(field, event.target.value) }}
      />
      <small id={hintId}>{t('commaHint')} {t(hint)} {t('wildcardHint')}</small>
    </div>
  }
  const idId = `${prefix}-id`
  const nameId = `${prefix}-name`
  const rankId = `${prefix}-rank`
  const enabledId = `${prefix}-enabled`
  const methodId = `${prefix}-method`
  const preferencesId = `${prefix}-preferences`
  const memoryId = `${prefix}-memory`
  return <section className={styles.editor} aria-labelledby={`${prefix}-title`}>
    <h2 id={`${prefix}-title`}>{existing === undefined ? t('createTitle') : t('editTitle')}</h2>
    <div className={styles.two}>
      <div className={styles.field}>
        <label htmlFor={idId}>{t('id')}</label>
        <input
          id={idId}
          value={draft.id}
          disabled={existing !== undefined || saving}
          required
          pattern="[a-z][a-z0-9-]*"
          spellCheck={false}
          aria-describedby={`${idId}-hint`}
          onChange={(event) => { set('id', event.target.value) }}
        />
        <small id={`${idId}-hint`}>{t('idHint')}</small>
      </div>
      <div className={styles.field}>
        <label htmlFor={nameId}>{t('name')}</label>
        <input
          id={nameId}
          value={draft.name}
          disabled={saving}
          required
          aria-describedby={`${nameId}-hint`}
          onChange={(event) => { set('name', event.target.value) }}
        />
        <small id={`${nameId}-hint`}>{t('nameHint')}</small>
      </div>
    </div>
    <div className={styles.two}>
      <div className={styles.field}>
        <label htmlFor={rankId}>{t('rank')}</label>
        <input
          id={rankId}
          type="number"
          value={draft.rank}
          disabled={saving}
          required
          aria-describedby={`${rankId}-hint`}
          onChange={(event) => { set('rank', event.target.value) }}
        />
        <small id={`${rankId}-hint`}>{t('rankHint')}</small>
      </div>
      <div className={styles.toggleField}>
        <span id={`${enabledId}-label`}>{t('availability')}</span>
        <label className={styles.toggle} htmlFor={enabledId}>
          <input
            id={enabledId}
            type="checkbox"
            checked={draft.enabled}
            disabled={saving}
            aria-labelledby={`${enabledId}-label`}
            aria-describedby={`${enabledId}-hint`}
            onChange={(event) => { set('enabled', event.target.checked) }}
          />
          <span aria-hidden="true">{draft.enabled ? t('enabled') : t('disabled')}</span>
        </label>
        <small id={`${enabledId}-hint`}>{t('enabledHint')}</small>
      </div>
    </div>
    <fieldset className={styles.group} disabled={saving}>
      <legend>{t('matchTitle')}</legend>
      <p>{t('matchIntro')}</p>
      <div className={styles.attributes}>
        {MATCH_FIELDS.map(({ field, label, hint }) => <div key={field}>{textField(field, label, hint)}</div>)}
      </div>
    </fieldset>
    <div className={styles.field}>
      <label htmlFor={methodId}>{t('method')}</label>
      <textarea
        id={methodId}
        className={styles.method}
        rows={8}
        value={draft.method}
        disabled={saving}
        required
        aria-describedby={`${methodId}-hint`}
        onChange={(event) => { set('method', event.target.value) }}
      />
      <small id={`${methodId}-hint`} className={styles.variables}>
        {t('methodHint')} {variables.map(variable => <code key={variable}>{`{{${variable}}}`}</code>)}
      </small>
    </div>
    <fieldset className={styles.group} disabled={saving}>
      <legend>{t('personalTitle')}</legend>
      <p>{t('privateHint')}</p>
      <div className={styles.two}>
        <div className={styles.field}>
          <label htmlFor={preferencesId}>{t('preferences')}</label>
          <textarea
            id={preferencesId}
            rows={4}
            value={draft.preferences}
            aria-describedby={`${preferencesId}-hint`}
            onChange={(event) => { set('preferences', event.target.value) }}
          />
          <small id={`${preferencesId}-hint`}>{t('preferencesHint')}</small>
        </div>
        <div className={styles.field}>
          <label htmlFor={memoryId}>{t('memory')}</label>
          <textarea
            id={memoryId}
            rows={4}
            value={draft.memory}
            aria-describedby={`${memoryId}-hint`}
            onChange={(event) => { set('memory', event.target.value) }}
          />
          <small id={`${memoryId}-hint`}>{t('memoryHint')}</small>
        </div>
      </div>
    </fieldset>
    <PreviewPanel
      key={existing === undefined ? 'new' : `${existing.id}:${String(existing.version)}`}
      connection={connection}
      template={existing}
      dirty={dirty}
      saving={saving}
      t={t}
    />
    <footer className={styles.actions}>
      <button type="button" className={styles.secondary} disabled={saving} onClick={cancel}>{t('cancel')}</button>
      <button
        type="button"
        className={styles.primary}
        disabled={saving || !canSave}
        onClick={() => { void save() }}
      >{saving ? t('saving') : t('save')}</button>
    </footer>
  </section>
}

function PreviewPanel({ connection, template, dirty, saving, t }: {
  connection: ConnectionHandle
  template: TaskTemplateView | undefined
  dirty: boolean
  saving: boolean
  t: TaskTemplateSectionInjected['t']
}): ReactNode {
  const prefix = useId()
  const [draft, setDraft] = useState<PreviewDraft>(() => template === undefined
    ? { taskType: 'general', domain: 'general', objective: '', outputFormat: 'text', language: 'en' }
    : previewDraftOf(template))
  const [previewing, setPreviewing] = useState(false)
  const [error, setError] = useState<string>()
  const [selection, setSelection] = useState<TaskTemplateSelection>()
  useEffect(() => {
    setError(undefined)
    setSelection(undefined)
  }, [template?.enabled, template?.personalization?.memory, template?.personalization?.preferences])
  const ready = [draft.taskType, draft.domain, draft.objective, draft.outputFormat, draft.language]
    .every(value => value.trim() !== '')
  const disabled = template === undefined || !template.enabled || dirty || saving || previewing || !ready
  const hint = template === undefined
    ? t('previewSaveFirst')
    : !template.enabled
      ? t('previewEnableFirst')
      : dirty
        ? t('previewDirty')
        : t('previewIntro')
  const set = (field: keyof PreviewDraft, value: string): void => {
    setDraft(current => ({ ...current, [field]: value }))
    setSelection(undefined)
    setError(undefined)
  }
  const preview = async (): Promise<void> => {
    /* v8 ignore next -- the Preview button is disabled for every rejected state. */
    if (template === undefined || disabled) return
    setPreviewing(true)
    setError(undefined)
    setSelection(undefined)
    try {
      const next = await call<TaskTemplateSelection>(connection, 'preview', {
        id: template.id,
        attributes: previewAttributes(template, draft),
      })
      if (next.decision !== 'inject' || next.selected === undefined) {
        throw new Error(t('previewMissing'))
      }
      setSelection(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPreviewing(false)
    }
  }
  const fields: ReadonlyArray<{
    field: keyof PreviewDraft
    label: TaskTemplateLocaleKey
    hint: TaskTemplateLocaleKey
    wide?: boolean
  }> = [
    { field: 'objective', label: 'previewObjective', hint: 'previewObjectiveHint', wide: true },
    { field: 'taskType', label: 'previewTaskType', hint: 'previewTaskTypeHint' },
    { field: 'domain', label: 'previewDomain', hint: 'previewDomainHint' },
    { field: 'outputFormat', label: 'previewOutputFormat', hint: 'previewOutputFormatHint' },
    { field: 'language', label: 'previewLanguage', hint: 'previewLanguageHint' },
  ]
  const content = selection?.selected?.content
  return <fieldset className={styles.preview} aria-busy={previewing}>
    <legend>{t('previewTitle')}</legend>
    <p id={`${prefix}-hint`}>{hint}</p>
    <div className={styles.previewFields}>
      {fields.map(({ field, label, hint: fieldHint, wide }) => {
        const id = `${prefix}-${field}`
        return <div
          key={field}
          className={`${styles.field} ${wide === true ? styles.wide : ''}`}
        >
          <label htmlFor={id}>{t(label)}</label>
          <input
            id={id}
            value={draft[field]}
            disabled={saving || previewing}
            required
            aria-describedby={`${id}-hint`}
            onChange={(event) => { set(field, event.target.value) }}
          />
          <small id={`${id}-hint`}>{t(fieldHint)}</small>
        </div>
      })}
    </div>
    <button
      type="button"
      className={styles.secondary}
      disabled={disabled}
      aria-describedby={`${prefix}-hint`}
      onClick={() => { void preview() }}
    >{previewing ? t('previewing') : t('previewAction')}</button>
    <div className={styles.previewStatus} aria-live="polite">
      {error === undefined ? null : <p className={styles.error} role="alert">{error}</p>}
      {content === undefined ? null : <section className={styles.previewResult} aria-label={t('previewResult')}>
        <h3>{t('previewMethod')}</h3>
        <pre>{content.method}</pre>
        {content.preferences === undefined ? null : <><h3>{t('previewPreferences')}</h3><pre>{content.preferences}</pre></>}
        {content.memory === undefined ? null : <><h3>{t('previewMemory')}</h3><pre>{content.memory}</pre></>}
      </section>}
    </div>
  </fieldset>
}
