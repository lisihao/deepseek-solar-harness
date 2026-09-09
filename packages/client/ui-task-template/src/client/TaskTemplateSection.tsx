import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { TaskTemplateMatch, TaskTemplatePersonalization } from '@deepseek-ai/dsh-task-template'
import { TASK_TEMPLATE_RPC_CHANNEL, type TaskTemplateRpcSnapshotV1, type TaskTemplateView } from '@deepseek-ai/dsh-task-template-rpc/shared'
import type { TaskTemplateLocaleKey } from './locales.ts'
import styles from './TaskTemplateSection.module.css'

export interface TaskTemplateSectionInjected {
  readonly connection: ConnectionHandle
  readonly t: (key: TaskTemplateLocaleKey) => string
}

export type TaskTemplateSectionProps = Partial<TaskTemplateSectionInjected>

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

const EMPTY: Draft = {
  id: '', name: '', rank: '0', method: '', enabled: true,
  taskTypes: '', domains: '', objectiveKeywords: '', outputFormats: '', requiredTools: '', requiredSkills: '',
  operators: '', languages: '', riskLevels: '', priorities: '', preferences: '', memory: '',
}

function joined(values: readonly string[] | undefined): string { return values?.join(', ') ?? '' }
function draftOf(template: TaskTemplateView): Draft {
  return {
    id: template.id, name: template.name, rank: String(template.rank), method: template.method, enabled: template.enabled,
    taskTypes: joined(template.match.taskTypes), domains: joined(template.match.domains),
    objectiveKeywords: joined(template.match.objectiveKeywords), outputFormats: joined(template.match.outputFormats),
    requiredTools: joined(template.match.requiredTools), requiredSkills: joined(template.match.requiredSkills),
    operators: joined(template.match.operators), languages: joined(template.match.languages),
    riskLevels: joined(template.match.riskLevels), priorities: joined(template.match.priorities),
    preferences: template.personalization?.preferences ?? '', memory: template.personalization?.memory ?? '',
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

async function call(connection: ConnectionHandle, endpoint: string, payload: unknown): Promise<TaskTemplateRpcSnapshotV1> {
  const response = await connection.rpc.call(TASK_TEMPLATE_RPC_CHANNEL, endpoint, payload)
  if (!response.ok) throw new Error(response.error.message)
  return response.value as unknown as TaskTemplateRpcSnapshotV1
}

function sameMethod(template: TaskTemplateView, draft: Draft): boolean {
  return template.name === draft.name.trim()
    && template.rank === Number(draft.rank)
    && template.method === draft.method
    && JSON.stringify(template.match) === JSON.stringify(matchOf(draft))
}

export function TaskTemplateSection(props: TaskTemplateSectionProps): ReactNode {
  if (props.connection === undefined || props.t === undefined) return null
  return <Loaded connection={props.connection} t={props.t} />
}

function Loaded({ connection, t }: TaskTemplateSectionInjected): ReactNode {
  const [snapshot, setSnapshot] = useState<TaskTemplateRpcSnapshotV1>()
  const [error, setError] = useState<string>()
  const [selectedId, setSelectedId] = useState<string>()
  const [draft, setDraft] = useState<Draft>()
  const [saving, setSaving] = useState(false)
  const selected = useMemo(() => snapshot?.templates.find(item => item.id === selectedId), [snapshot, selectedId])
  const load = useCallback((): void => {
    setError(undefined)
    void call(connection, 'list', {}).then(setSnapshot, cause => setError(cause instanceof Error ? cause.message : String(cause)))
  }, [connection])
  useEffect(load, [load])

  const edit = (template: TaskTemplateView): void => { setSelectedId(template.id); setDraft(draftOf(template)); setError(undefined) }
  const create = (): void => { setSelectedId(undefined); setDraft({ ...EMPTY }); setError(undefined) }
  const set = (field: keyof Draft, value: string | boolean): void => {
    setDraft(current => current === undefined ? current : { ...current, [field]: value })
  }
  const save = (): void => {
    if (draft === undefined || saving) return
    setSaving(true); setError(undefined)
    const work = async (): Promise<void> => {
      let next = snapshot
      if (selected === undefined) {
        next = await call(connection, 'create', { draft: { id: draft.id.trim(), name: draft.name.trim(), rank: Number(draft.rank), method: draft.method, match: matchOf(draft) } })
      } else {
        if (!sameMethod(selected, draft)) next = await call(connection, 'update', { id: selected.id, patch: { name: draft.name.trim(), rank: Number(draft.rank), method: draft.method, match: matchOf(draft) } })
        if (selected.enabled !== draft.enabled) next = await call(connection, 'set-enabled', { id: selected.id, enabled: draft.enabled })
      }
      const id = selected?.id ?? draft.id.trim()
      const currentPersonal = selected?.personalization ?? null
      const personal = personalOf(draft)
      if (JSON.stringify(currentPersonal) !== JSON.stringify(personal)) next = await call(connection, 'personalize', { id, personalization: personal })
      setSnapshot(next); setSelectedId(id)
      const saved = next?.templates.find(item => item.id === id)
      setDraft(saved === undefined ? undefined : draftOf(saved))
    }
    void work().catch(cause => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setSaving(false))
  }
  const remove = (template: TaskTemplateView): void => {
    if (!window.confirm(t('confirmDelete'))) return
    setError(undefined)
    void call(connection, 'delete', { id: template.id }).then((next) => {
      setSnapshot(next)
      if (selectedId === template.id) { setSelectedId(undefined); setDraft(undefined) }
    }, cause => setError(cause instanceof Error ? cause.message : String(cause)))
  }

  if (error !== undefined && snapshot === undefined) return <main className={styles.page}><p className={styles.error}>{t('loadFailed')}: {error}</p><button onClick={load}>{t('retry')}</button></main>
  return <main className={styles.page}>
    <header className={styles.hero}><div><h1>{t('title')}</h1><p>{t('intro')}</p></div><button className={styles.primary} onClick={create}>{t('add')}</button></header>
    {error !== undefined && <p className={styles.error} role="alert">{error}</p>}
    <div className={styles.layout}>
      <section className={styles.catalog}>
        {snapshot?.templates.length === 0 && <p className={styles.empty}>{t('empty')}</p>}
        {snapshot?.templates.map(template => <article
          key={template.id} className={styles.card} data-active={selectedId === template.id || undefined}
        >
          <button className={styles.cardBody} onClick={() => edit(template)}><span><strong>{template.name}</strong><code>{template.id}</code></span><small>{t('version')} {template.version} · {template.history.length} {t('history')}</small></button>
          <span className={template.enabled ? styles.on : styles.off}>{template.enabled ? t('enabled') : t('disabled')}</span>
          <button className={styles.danger} onClick={() => remove(template)}>{t('remove')}</button>
        </article>)}
      </section>
      {draft !== undefined && <Editor
        draft={draft} existing={selected !== undefined} saving={saving} t={t}
        set={set} save={save} cancel={() => setDraft(undefined)}
      />}
    </div>
  </main>
}

function Editor({ draft, existing, saving, t, set, save, cancel }: {
  draft: Draft
  existing: boolean
  saving: boolean
  t: TaskTemplateSectionInjected['t']
  set: (field: keyof Draft, value: string | boolean) => void
  save: () => void
  cancel: () => void
}): ReactNode {
  const fields: Array<[keyof Draft, TaskTemplateLocaleKey]> = [
    ['taskTypes', 'taskTypes'], ['domains', 'domains'], ['objectiveKeywords', 'keywords'], ['outputFormats', 'outputFormats'],
    ['operators', 'operators'], ['requiredTools', 'tools'], ['requiredSkills', 'skills'], ['languages', 'languages'],
    ['riskLevels', 'risks'], ['priorities', 'priorities'],
  ]
  return <section className={styles.editor}>
    <h2>{existing ? t('editTitle') : t('createTitle')}</h2>
    <div className={styles.two}><label>{t('id')}<input value={draft.id} disabled={existing} onChange={event => set('id', event.target.value)} /><small>{t('idHint')}</small></label><label>{t('name')}<input value={draft.name} onChange={event => set('name', event.target.value)} /></label></div>
    <div className={styles.two}><label>{t('rank')}<input type="number" value={draft.rank} onChange={event => set('rank', event.target.value)} /><small>{t('rankHint')}</small></label><label className={styles.toggle}><input type="checkbox" checked={draft.enabled} onChange={event => set('enabled', event.target.checked)} />{draft.enabled ? t('enabled') : t('disabled')}</label></div>
    <div className={styles.attributes}>{fields.map(([field, key]) => <label key={field}>{t(key)}<input value={String(draft[field])} onChange={event => set(field, event.target.value)} /><small>{t('commaHint')}</small></label>)}</div>
    <label>{t('method')}<textarea rows={8} value={draft.method} onChange={event => set('method', event.target.value)} /><small>{t('methodHint')}</small></label>
    <div className={styles.two}><label>{t('preferences')}<textarea rows={4} value={draft.preferences} onChange={event => set('preferences', event.target.value)} /></label><label>{t('memory')}<textarea rows={4} value={draft.memory} onChange={event => set('memory', event.target.value)} /></label></div>
    <p className={styles.private}>{t('privateHint')}</p>
    <footer><button onClick={cancel}>{t('cancel')}</button><button className={styles.primary} disabled={saving} onClick={save}>{saving ? t('saving') : t('save')}</button></footer>
  </section>
}
