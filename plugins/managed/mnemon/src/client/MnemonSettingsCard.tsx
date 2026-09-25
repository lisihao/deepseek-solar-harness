import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import type { ClientConnectionHandle, ClientSettingsScope, ClientSettingsSnapshot, Config, InteractionConfig, SettingsOperation, TaskAgentModelCatalog } from '../shared/contracts.ts'
import { MnemonClient } from './api.ts'
import css from './MnemonSettingsCard.module.css'
import { GlobalLocationSetting } from './GlobalLocationSetting.tsx'
import { translateZh, type MnemonTranslate } from './locales.ts'
import { MnemonPackSection } from './MnemonPackSection.tsx'
import { ProviderIcon } from './ProviderIcon.tsx'
import { ProviderSettingsSection } from './ProviderSettingsSection.tsx'

export interface MnemonSettingsCardProps {
  scope: ClientSettingsScope<Config>
  /** Separate live namespace; falls back to the core scope for older hosts. */
  interactionScope?: ClientSettingsScope<InteractionConfig>
  /** Loopback RPC used for whole-directory ZIP backup and restore. */
  connection?: ClientConnectionHandle
  sessionId?: string
  workspaceId?: string
  workspaceLabel?: string
  t?: MnemonTranslate
}

type CoreField = 'displayMode' | 'storageScope' | 'dataDir'
type TaskAgentField = 'taskAgentModelMode' | 'taskAgentProvider' | 'taskAgentModel'
type InteractionField = 'turnBar' | 'saveAction'
type Field = CoreField | TaskAgentField | InteractionField
interface Draft extends Record<InteractionField, boolean> {
  displayMode: 'sidebar' | 'buildin'
  storageScope: string
  dataDir: string
  taskAgentModelMode: 'inherit' | 'fixed'
  taskAgentProvider: string
  taskAgentModel: string
}

const CORE_FIELDS: CoreField[] = ['displayMode', 'storageScope', 'dataDir']
const INTERACTION_FIELDS: InteractionField[] = ['turnBar', 'saveAction']
const TASK_AGENT_FIELDS: TaskAgentField[] = ['taskAgentModelMode', 'taskAgentProvider', 'taskAgentModel']

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function legacyPackDirectory(value: Config): string {
  const packs = value.customPacks ?? []
  return packs.find(pack => pack.id === value.customPackId)?.dataDir?.trim()
    ?? (packs.length === 1 ? packs[0]?.dataDir?.trim() : undefined)
    ?? ''
}

function coreDraft(value: Config | undefined): Pick<Draft, CoreField | TaskAgentField> {
  const resolved = value ?? {}
  const dataDir = resolved.dataDir?.trim() || legacyPackDirectory(resolved)
  return {
    displayMode: resolved.displayMode ?? 'sidebar',
    storageScope: resolved.storageScope ?? (dataDir === '' ? 'global' : 'custom'),
    dataDir,
    taskAgentModelMode: resolved.taskAgentModel?.mode === 'fixed' ? 'fixed' : 'inherit',
    taskAgentProvider: resolved.taskAgentModel?.provider?.trim() ?? '',
    taskAgentModel: resolved.taskAgentModel?.model?.trim() ?? '',
  }
}

function interactionDraft(value: InteractionConfig | undefined): Pick<Draft, InteractionField> {
  return {
    turnBar: value?.turnBar !== false,
    saveAction: value?.saveAction !== false,
  }
}

function draftOf(core: Config | undefined, interaction: InteractionConfig | undefined): Draft {
  return { ...coreDraft(core), ...interactionDraft(interaction) }
}

function validation(t: MnemonTranslate, draft: Draft): string | null {
  if (!['global', 'workspace', 'custom'].includes(draft.storageScope)) return t('config.invalidScope')
  if (draft.storageScope === 'custom') {
    const directory = draft.dataDir.trim()
    if (directory === '') return t('config.customRequired')
    const posixAbsolute = directory.startsWith('/')
    const homeRelative = directory === '~' || directory.startsWith('~/')
    const windowsDriveAbsolute = /^[a-zA-Z]:[\\/]/.test(directory)
    const windowsUncAbsolute = /^\\\\[^\\/]+[\\/][^\\/]+/.test(directory)
    if (!posixAbsolute && !homeRelative && !windowsDriveAbsolute && !windowsUncAbsolute) return t('config.customAbsolute')
  }
  if (draft.taskAgentModelMode === 'fixed' && (draft.taskAgentProvider.trim() === '' || draft.taskAgentModel.trim() === '')) return t('config.taskAgentRouteRequired')
  return null
}

function useScope<T>(scope: ClientSettingsScope<T>): ClientSettingsSnapshot<T> {
  const subscribe = useMemo(() => scope.subscribe.bind(scope), [scope])
  const getSnapshot = useMemo(() => scope.getSnapshot.bind(scope), [scope])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

function operations(fields: readonly Field[], dirty: ReadonlySet<Field>, draft: Draft): SettingsOperation[] {
  return fields.flatMap((field): SettingsOperation[] => {
    if (!dirty.has(field)) return []
    if (field === 'dataDir' && draft.dataDir.trim() === '') return [{ op: 'unset', path: [field] }]
    const value = draft[field]
    return [{ op: 'set', path: [field], value: typeof value === 'string' ? value.trim() : value }]
  })
}

async function commit<T>(scope: ClientSettingsScope<T>, edits: SettingsOperation[]): Promise<void> {
  if (scope.mutate !== undefined) return scope.mutate(edits)
  for (const edit of edits) {
    if (edit.path.length === 1) {
      if (edit.op === 'set') await scope.set(edit.path[0]!, edit.value)
      else await scope.unset(edit.path[0]!)
    } else if (edit.op === 'set') await scope.setPath(edit.path, edit.value)
    else await scope.unsetPath(edit.path)
  }
}

/** Dedicated Mnemon page contributed directly to DSH's settings navigation. */
export function MnemonSettingsCard({ scope, interactionScope: suppliedInteractionScope, connection, sessionId, workspaceId, workspaceLabel, t = translateZh }: MnemonSettingsCardProps): JSX.Element | null {
  const interactionScope = suppliedInteractionScope ?? scope as unknown as ClientSettingsScope<InteractionConfig>
  const coreSnapshot = useScope(scope)
  const interactionSnapshot = useScope(interactionScope)
  const [draft, setDraft] = useState<Draft>(() => draftOf(coreSnapshot.value, interactionSnapshot.value))
  const [dirty, setDirty] = useState<Set<Field>>(() => new Set())
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [applied, setApplied] = useState(false)
  const [targetRevision, setTargetRevision] = useState(0)
  const [modelCatalog, setModelCatalog] = useState<TaskAgentModelCatalog | null>(null)
  const [modelCatalogState, setModelCatalogState] = useState<'unavailable' | 'loading' | 'ready' | 'error'>(connection === undefined ? 'unavailable' : 'loading')
  const [modelCatalogError, setModelCatalogError] = useState<string | null>(null)
  const [fullModelCatalogLoaded, setFullModelCatalogLoaded] = useState(false)
  const modelCatalogRequest = useRef(0)
  const configuredTaskAgentMode = coreSnapshot.value?.taskAgentModel?.mode === 'fixed' ? 'fixed' : 'inherit'

  useEffect(() => {
    if (dirty.size === 0) setDraft(draftOf(coreSnapshot.value, interactionSnapshot.value))
  }, [dirty.size, coreSnapshot.value, interactionSnapshot.value])

  const loadModelCatalog = useCallback((includeCatalog: boolean): void => {
    if (connection === undefined) {
      modelCatalogRequest.current += 1
      setModelCatalog(null)
      setModelCatalogState('unavailable')
      setModelCatalogError(null)
      setFullModelCatalogLoaded(false)
      return
    }
    const request = modelCatalogRequest.current + 1
    modelCatalogRequest.current = request
    setModelCatalogState('loading')
    setModelCatalogError(null)
    void new MnemonClient(connection).taskAgentModels(includeCatalog).then(catalog => {
      if (modelCatalogRequest.current !== request) return
      setModelCatalog(catalog)
      setModelCatalogState('ready')
      setFullModelCatalogLoaded(includeCatalog)
      if (includeCatalog) {
        setDraft(current => {
          if (current.taskAgentModelMode !== 'fixed') return current
          const provider = current.taskAgentProvider
            || catalog.defaultSelection?.provider
            || catalog.groups[0]?.id
            || ''
          const group = catalog.groups.find(candidate => candidate.id === provider)
          const model = current.taskAgentModel
            || (catalog.defaultSelection?.provider === provider ? catalog.defaultSelection.model : undefined)
            || group?.models[0]?.id
            || ''
          return provider === current.taskAgentProvider && model === current.taskAgentModel
            ? current
            : { ...current, taskAgentProvider: provider, taskAgentModel: model }
        })
      }
    }, reason => {
      if (modelCatalogRequest.current !== request) return
      setModelCatalogState('error')
      setModelCatalogError(reason instanceof Error ? reason.message : String(reason))
    })
  }, [connection])

  useEffect(() => {
    loadModelCatalog(configuredTaskAgentMode === 'fixed')
    return () => { modelCatalogRequest.current += 1 }
  }, [configuredTaskAgentMode, loadModelCatalog])

  const coreUser = useMemo(() => record(coreSnapshot.user), [coreSnapshot.user])
  const activeScope = coreDraft(coreSnapshot.value).storageScope === 'workspace' ? 'workspace' : 'global'
  const error = validation(t, draft)
  const loading = coreSnapshot.status === 'loading' || interactionSnapshot.status === 'loading'
  // A successful writable settings snapshot is the Host's authoritative
  // capability grant. Remote trusted-host deployments deliberately expose the
  // same management RPCs, so transport locality is not a capability signal.
  const writable = coreSnapshot.writable && interactionSnapshot.writable

  if (coreSnapshot.status === 'unavailable' && interactionSnapshot.status === 'unavailable') {
    return <section className={css.page} aria-label={t('config.aria')}><p className={css.error} role="alert">{t('config.unavailable')}</p></section>
  }

  const edit = (field: Field, value: string | boolean): void => {
    setDraft(current => ({ ...current, [field]: value }))
    setDirty(current => new Set(current).add(field))
    setFailed(null)
    setApplied(false)
  }

  const editMany = (values: Partial<Draft>): void => {
    setDraft(current => ({ ...current, ...values }))
    setDirty(current => new Set([...current, ...Object.keys(values) as Field[]]))
    setFailed(null)
    setApplied(false)
  }

  const discard = (): void => {
    setDraft(draftOf(coreSnapshot.value, interactionSnapshot.value))
    setDirty(new Set()); setFailed(null); setApplied(false)
  }

  const save = async (): Promise<void> => {
    if (error !== null || dirty.size === 0 || saving || !writable) return
    setSaving(true); setFailed(null)
    try {
      const coreOps = operations(CORE_FIELDS, dirty, draft)
      const regularCoreChanged = coreOps.length > 0
      const taskAgentChanged = TASK_AGENT_FIELDS.some(field => dirty.has(field))
      if (regularCoreChanged) {
        if (Object.hasOwn(coreUser, 'customPackId')) coreOps.push({ op: 'unset', path: ['customPackId'] })
        if (Object.hasOwn(coreUser, 'customPacks')) coreOps.push({ op: 'unset', path: ['customPacks'] })
      }
      if (taskAgentChanged) {
        coreOps.push({
          op: 'set',
          path: ['taskAgentModel'],
          value: draft.taskAgentModelMode === 'inherit'
            ? { mode: 'inherit' }
            : { mode: 'fixed', provider: draft.taskAgentProvider.trim(), model: draft.taskAgentModel.trim() },
        })
      }
      const interactionOps = operations(INTERACTION_FIELDS, dirty, draft)
      await Promise.all([
        ...(coreOps.length === 0 ? [] : [commit(scope, coreOps)]),
        ...(interactionOps.length === 0 ? [] : [commit(interactionScope, interactionOps)]),
      ])
      setDirty(new Set())
      setApplied(true)
      if (regularCoreChanged) setTargetRevision(revision => revision + 1)
    } catch (reason) {
      setFailed(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  const coreDisabled = loading || saving || !coreSnapshot.writable
  const interactionDisabled = loading || saving || !interactionSnapshot.writable
  const scopeChanging = dirty.has('storageScope') || dirty.has('dataDir')
  return (
    <section className={css.page} aria-label={t('config.aria')} aria-busy={saving || loading}>
      {loading ? <p className={css.loading} role="status">{t('common.loading')}</p> : <>
        <header className={css.pageHeader}>
          <h1>{t('config.title')}</h1>
          <p>{t('config.description')}</p>
        </header>

        <section className={css.section} aria-labelledby="mnemon-display-heading">
          <div className={css.sectionHeading}>
            <div><h2 id="mnemon-display-heading">{t('config.displayTitle')}</h2><p>{t('config.displayDescription')}</p></div>
          </div>
          <div className={`${css.choiceGrid} ${css.displayGrid}`} role="radiogroup" aria-label={t('config.displayAria')}>
            <ChoiceCard id="mnemon-display-sidebar" name="mnemon-display" label={t('config.displaySidebar')} detail={t('config.displaySidebarHint')} checked={draft.displayMode === 'sidebar'} disabled={coreDisabled} onChange={() => edit('displayMode', 'sidebar')} />
            <ChoiceCard id="mnemon-display-buildin" name="mnemon-display" label={t('config.displayBuildin')} detail={t('config.displayBuildinHint')} checked={draft.displayMode === 'buildin'} disabled={coreDisabled} onChange={() => edit('displayMode', 'buildin')} />
          </div>
        </section>

        <section className={css.section} aria-labelledby="mnemon-storage-heading">
          <div className={css.sectionHeading}>
            <div><h2 id="mnemon-storage-heading">{t('config.storageTitle')}</h2><p>{t('config.storageDescription')}</p></div>
          </div>
          <div className={css.choiceGrid} role="radiogroup" aria-label={t('config.scopeAria')}>
            <ChoiceCard id="mnemon-storage-global" name="mnemon-storage" label={t('config.global')} detail={t('config.globalScopeHint')} checked={draft.storageScope !== 'workspace'} disabled={coreDisabled} onChange={() => edit('storageScope', draft.dataDir.trim() === '' ? 'global' : 'custom')} />
            <ChoiceCard id="mnemon-storage-workspace" name="mnemon-storage" label={t('config.workspace')} detail="<workspace>/.mnemon" checked={draft.storageScope === 'workspace'} disabled={coreDisabled} onChange={() => edit('storageScope', 'workspace')} />
          </div>
        </section>

        <section className={css.section} aria-labelledby="mnemon-providers-heading">
          <div className={css.sectionHeading}>
            <div><h2 id="mnemon-providers-heading">{t('config.providersTitle')}</h2><p>{t('config.providersDescription')}</p></div>
          </div>
          <details className={css.providerPanel} open>
            <summary>
              <span className={css.providerIdentity}><ProviderIcon providerId="mnemon-native" className={css.nativeMark} /><span><strong>mnemon</strong><small>{t('config.nativeSummary')}</small></span></span>
              <span className={css.providerHeaderMeta}><span className={css.providerScopeTag} data-scope={activeScope}>{t(`config.${activeScope}`)}</span><span className={css.providerState}>{t('config.officialNative')}</span></span>
            </summary>
            <div className={css.providerPanelBody}>
              <GlobalLocationSetting
                name="mnemon-native-location"
                ariaLabel={t('config.nativeGlobalLocation')}
                label={t('config.nativeGlobalLocation')}
                hint={draft.storageScope === 'workspace' ? t('config.nativeGlobalLocationWorkspaceHint') : t('config.nativeGlobalLocationHint')}
                defaultLabel={t('config.nativeDefaultLocation')}
                customLabel={t('config.custom')}
                custom={draft.storageScope === 'custom'}
                workspace={draft.storageScope === 'workspace'}
                disabled={coreDisabled}
                onChange={custom => custom ? edit('storageScope', 'custom') : editMany({ storageScope: 'global', dataDir: '' })}
              >
                <div className={css.settingRow}>
                  <div className={css.settingCopy}><strong>{t('config.customDirectory')}</strong><small>{t('config.customDirectoryHint')}</small></div>
                  <div className={css.directoryControl}>
                    <input
                      id="mnemon-custom-directory"
                      name="mnemon-custom-directory"
                      type="text"
                      className={css.directoryInput}
                      aria-label={t('config.customAria')}
                      aria-invalid={error !== null}
                      placeholder={t('config.customPlaceholder')}
                      value={draft.dataDir}
                      disabled={coreDisabled}
                      autoComplete="off"
                      spellCheck={false}
                      autoCapitalize="none"
                      autoCorrect="off"
                      onChange={event => edit('dataDir', event.target.value)}
                    />
                  </div>
                </div>
              </GlobalLocationSetting>
              <MnemonPackSection {...(connection === undefined ? {} : { connection })} {...(sessionId === undefined ? {} : { sessionId })} {...(workspaceId === undefined ? {} : { workspaceId })} refreshKey={targetRevision} t={t} embedded />
            </div>
          </details>
          <ProviderSettingsSection
            {...(connection === undefined ? {} : { connection })}
            {...(sessionId === undefined ? {} : { sessionId })}
            {...(workspaceId === undefined ? {} : { workspaceId })}
            {...(activeScope !== 'workspace' || workspaceLabel === undefined ? {} : { workspaceLabel })}
            activeScope={activeScope}
            refreshKey={targetRevision}
            disabled={coreDisabled}
            scopeChanging={scopeChanging}
            t={t}
          />
        </section>

        <TaskAgentModelSection
          draft={draft}
          catalog={modelCatalog}
          state={modelCatalogState}
          error={modelCatalogError}
          disabled={coreDisabled}
          fullCatalogLoaded={fullModelCatalogLoaded}
          onLoadCatalog={() => loadModelCatalog(true)}
          onEdit={edit}
          onEditMany={editMany}
          t={t}
        />

        <section className={css.section} aria-labelledby="mnemon-interaction-heading">
          <div className={css.sectionHeading}>
            <div><h2 id="mnemon-interaction-heading">{t('config.interactionTitle')}</h2><p>{t('config.interactionHint')}</p></div>
          </div>
          <div className={css.rowGroup}>
            <ToggleRow id="mnemon-interaction-turn-bar" label={t('config.interactionTurnBar')} hint={t('config.interactionTurnBarHint')} checked={draft.turnBar} disabled={interactionDisabled} onChange={value => edit('turnBar', value)} />
            <ToggleRow id="mnemon-interaction-save-action" label={t('config.interactionSaveAction')} hint={t('config.interactionSaveActionHint')} checked={draft.saveAction} disabled={interactionDisabled} onChange={value => edit('saveAction', value)} />
          </div>
        </section>

        <div className={css.feedback} aria-live="polite">
          {error !== null && <p className={css.error} role="alert">{error}</p>}
          {failed !== null && <p className={css.error} role="alert">{t('config.saveFailed', { error: failed })}</p>}
          {applied && <p className={css.success} role="status">{t('config.ready')}</p>}
          {!writable && <p className={css.readOnly}>{t('config.readOnly')}</p>}
        </div>

        <footer className={`${css.actions} ${dirty.size > 0 ? css.actionsVisible : ''}`} aria-live="polite">
          <span>{t('config.unsaved')}</span>
          <div><button type="button" className={css.discard} disabled={saving} onClick={discard}>{t('config.discard')}</button><button type="button" className={css.save} disabled={saving || error !== null || !writable} onClick={() => void save()}>{saving ? t('config.saving') : t('config.save')}</button></div>
        </footer>
        <p className={css.settingsNote}>{t('config.noticeBefore')} <code>.dsh/settings.yaml</code>{t('config.noticeAfter')}</p>
      </>}
    </section>
  )
}

function TaskAgentModelSection(props: {
  draft: Draft
  catalog: TaskAgentModelCatalog | null
  state: 'unavailable' | 'loading' | 'ready' | 'error'
  error: string | null
  disabled: boolean
  fullCatalogLoaded: boolean
  onLoadCatalog: () => void
  onEdit: (field: Field, value: string | boolean) => void
  onEditMany: (values: Partial<Draft>) => void
  t: MnemonTranslate
}): JSX.Element {
  const groups = props.catalog?.groups ?? []
  const group = groups.find(candidate => candidate.id === props.draft.taskAgentProvider)
  const inherited = props.catalog?.defaultSelection
    ?? (props.catalog?.effective?.source === 'fixed' ? undefined : props.catalog?.effective)
  const effective = props.draft.taskAgentModelMode === 'fixed'
    ? (props.draft.taskAgentProvider.trim() === '' || props.draft.taskAgentModel.trim() === '' ? undefined : { provider: props.draft.taskAgentProvider, model: props.draft.taskAgentModel })
    : inherited

  const chooseFixed = (): void => {
    const preferredProvider = props.draft.taskAgentProvider
      || inherited?.provider
      || groups[0]?.id
      || ''
    const models = groups.find(candidate => candidate.id === preferredProvider)?.models ?? []
    const preferredModel = props.draft.taskAgentModel
      || (inherited?.provider === preferredProvider ? inherited.model : undefined)
      || models[0]?.id
      || ''
    props.onEditMany({ taskAgentModelMode: 'fixed', taskAgentProvider: preferredProvider, taskAgentModel: preferredModel })
    if (!props.fullCatalogLoaded) props.onLoadCatalog()
  }
  const chooseProvider = (provider: string): void => {
    const models = groups.find(candidate => candidate.id === provider)?.models ?? []
    props.onEditMany({ taskAgentProvider: provider, taskAgentModel: models[0]?.id ?? '' })
  }

  return <section className={css.section} aria-labelledby="mnemon-task-agent-heading">
    <div className={css.sectionHeading}>
      <div><h2 id="mnemon-task-agent-heading">{props.t('config.taskAgentTitle')}</h2><p>{props.t('config.taskAgentDescription')}</p></div>
      {props.state === 'loading' && <span className={css.miniSpinner} aria-hidden="true" />}
    </div>
    <div className={css.choiceGrid} role="radiogroup" aria-label={props.t('config.taskAgentModeAria')}>
      <ChoiceCard id="mnemon-task-agent-inherit" name="mnemon-task-agent" label={props.t('config.taskAgentInherit')} detail={props.t('config.taskAgentInheritHint')} checked={props.draft.taskAgentModelMode === 'inherit'} disabled={props.disabled} onChange={() => props.onEditMany({ taskAgentModelMode: 'inherit' })} />
      <ChoiceCard id="mnemon-task-agent-fixed" name="mnemon-task-agent" label={props.t('config.taskAgentFixed')} detail={props.t('config.taskAgentFixedHint')} checked={props.draft.taskAgentModelMode === 'fixed'} disabled={props.disabled || props.state === 'unavailable'} onChange={chooseFixed} />
    </div>
    <div className={css.taskAgentPanel} data-mode={props.draft.taskAgentModelMode}>
      {props.draft.taskAgentModelMode === 'fixed' && <div className={css.taskAgentFields}>
        <label>
          <span><strong>{props.t('config.taskAgentProvider')}</strong><small>{props.t('config.taskAgentProviderHint')}</small></span>
          <select aria-label={props.t('config.taskAgentProvider')} value={props.draft.taskAgentProvider} disabled={props.disabled || props.state !== 'ready'} onChange={event => chooseProvider(event.target.value)}>
            <option value="">{props.t('config.taskAgentChooseProvider')}</option>
            {props.draft.taskAgentProvider !== '' && !groups.some(candidate => candidate.id === props.draft.taskAgentProvider) && <option value={props.draft.taskAgentProvider}>{props.draft.taskAgentProvider}</option>}
            {groups.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
          </select>
        </label>
        <label>
          <span><strong>{props.t('config.taskAgentModel')}</strong><small>{props.t('config.taskAgentModelHint')}</small></span>
          <select aria-label={props.t('config.taskAgentModel')} value={props.draft.taskAgentModel} disabled={props.disabled || props.state !== 'ready' || group === undefined} onChange={event => props.onEdit('taskAgentModel', event.target.value)}>
            <option value="">{props.t('config.taskAgentChooseModel')}</option>
            {props.draft.taskAgentModel !== '' && !group?.models.some(model => model.id === props.draft.taskAgentModel) && <option value={props.draft.taskAgentModel}>{props.draft.taskAgentModel}</option>}
            {(group?.models ?? []).map(model => <option key={model.id} value={model.id}>{model.name}{model.inputModalities?.includes('image') === true ? ` · ${props.t('config.taskAgentImageInput')}` : ''}</option>)}
          </select>
        </label>
      </div>}
      <div className={css.taskAgentEffective}>
        <span>{props.t('config.taskAgentEffective')}</span>
        {effective === undefined
          ? <small>{props.state === 'loading' ? props.t('config.taskAgentLoading') : props.t('config.taskAgentUnavailable')}</small>
          : <code>{effective.provider} / {effective.model}</code>}
      </div>
      {props.state === 'error' && <p className={css.taskAgentWarning}>{props.t('config.taskAgentLoadFailed', { error: props.error ?? '' })}</p>}
      {(props.catalog?.failures.length ?? 0) > 0 && groups.length > 0 && <p className={css.taskAgentWarning}>{props.t('config.taskAgentPartial', { count: props.catalog!.failures.length })}</p>}
    </div>
  </section>
}

function ChoiceCard(props: { id: string; name: string; label: string; detail: string; checked: boolean; disabled: boolean; onChange: () => void }): JSX.Element {
  return <label className={css.choiceCard} htmlFor={props.id}><input id={props.id} name={props.name} type="radio" aria-label={props.label} checked={props.checked} disabled={props.disabled} onChange={props.onChange} /><span className={css.choiceFace}><strong>{props.label}</strong><small>{props.detail}</small><span className={css.check} aria-hidden="true">✓</span></span></label>
}

function ToggleRow(props: { id: string; label: string; hint: string; checked: boolean; disabled: boolean; onChange: (value: boolean) => void }): JSX.Element {
  return <label className={css.toggleRow} htmlFor={props.id}><span className={css.settingCopy}><strong>{props.label}</strong><small>{props.hint}</small></span><input id={props.id} type="checkbox" aria-label={props.label} checked={props.checked} disabled={props.disabled} onChange={event => props.onChange(event.target.checked)} /><span className={css.switch} aria-hidden="true"><i /></span></label>
}
