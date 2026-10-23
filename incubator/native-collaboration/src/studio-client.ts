import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactElement,
} from 'react'
import {
  additionalNodeParametersForProvider,
  canAddStudioEdge,
  canResumeStudioRun,
  currentCommandForDraft,
  decideStudioRunAction,
  editableStudioDraft,
  effortChoices,
  executorChoicesForProvider,
  forkStudioSource,
  formatJsonObject,
  initialStudioSelection,
  isCurrentStudioOverview,
  isCurrentStudioRunRecord,
  isCurrentStudioSource,
  isTerminalStudioRun,
  modelChoicesForProvider,
  nextStudioNode,
  nodeKindsForProvider,
  nodePropertyView,
  parseJsonObject,
  studioRunStatusLabel,
  upsertStudioDraft,
  upsertStudioRunRecord,
  upsertStudioSource,
  validateAdditionalNodeParametersForProvider,
  withAdditionalNodeParametersForProvider,
  withProviderNodeStringProperty,
  withStudioEdgeAdded,
  withStudioGraphMetadata,
  withStudioGraphParameters,
  withStudioGraphTitle,
  withStudioNode,
  withStudioNodeAdded,
  withStudioNodePosition,
  withoutStudioEdges,
  withoutStudioNodes,
  requestedProviderChoices,
  sameExecutionGraph,
  sourceExecutionRun,
  type EditableStudioDraft,
} from './studio-client-helpers.js'
import type {
  JsonObject,
  StudioDraft,
  StudioGraph,
  StudioNode,
  StudioNodeKind,
  StudioOverview,
  StudioRunRecord,
  StudioRun,
  StudioRunStatus,
  StudioSource,
  StudioUiApi,
} from './studio-contract.js'
import { SessionModeStyles, WorkflowStudioStyles } from './studio-style.js'

export interface WorkflowStudioPanelProps {
  readonly sessionId: string
  readonly api: StudioUiApi | undefined
  readonly error?: string
}

interface Notice {
  readonly tone: 'info' | 'error'
  readonly message: string
}

interface PendingCommand {
  readonly commandId: string
  readonly revision: number
}

interface StageData {
  readonly [key: string]: unknown
  readonly node: StudioNode
  readonly status?: StudioRunStatus
}

type StudioFlowNode = Node<StageData, 'studio-stage'>
type StudioFlowEdge = Edge

export type WorkflowStudioPresentation = 'loading' | 'unavailable' | 'empty' | 'selection' | 'editor'

export interface WorkflowStudioPresentationInput {
  readonly overview: Pick<StudioOverview, 'sources' | 'drafts'> | undefined
  readonly draft: EditableStudioDraft | undefined
  readonly loading: boolean
  readonly apiAvailable: boolean
  readonly hasServiceError: boolean
  readonly hasOverviewError: boolean
}

/**
 * Chooses the one primary screen state. Keeping this separate from React state
 * prevents an empty session from looking like an inactive editor.
 */
export function workflowStudioPresentation({
  overview,
  draft,
  loading,
  apiAvailable,
  hasServiceError,
  hasOverviewError,
}: WorkflowStudioPresentationInput): WorkflowStudioPresentation {
  if (draft !== undefined) return 'editor'
  if (!apiAvailable || hasServiceError || hasOverviewError) return 'unavailable'
  if (loading || overview === undefined) return 'loading'
  return overview.sources.length === 0 && overview.drafts.length === 0 ? 'empty' : 'selection'
}

/**
 * A revision number alone cannot tell whether a draft was persisted: revision
 * zero is valid for both an initial editable draft and a stored draft.
 */
export function studioDraftSaveStatus(
  draft: EditableStudioDraft | undefined,
  overview: Pick<StudioOverview, 'drafts'> | undefined,
  dirty: boolean,
): string | undefined {
  if (draft === undefined) return undefined
  if (dirty) return '有未保存修改'
  const persisted = overview?.drafts.some(saved => saved.id === draft.id && saved.revision === draft.expectedRevision) ?? false
  return persisted ? `已保存 · 版本 ${draft.expectedRevision}` : '尚未保存'
}

export interface WorkflowStudioRunAction {
  readonly label: string
  readonly hint: string
  readonly hintTone: 'muted' | 'warning'
  readonly disabled: boolean
}

/** Keeps the visible action aligned with the existing save-before-run guard. */
export function workflowStudioRunAction(
  dirty: boolean,
  commandId: string | undefined,
  commandBusy: boolean,
): WorkflowStudioRunAction {
  if (dirty) return {
    label: '保存后执行',
    hint: '先保存草稿；编辑和保存不会启动模型。',
    hintTone: 'muted',
    disabled: true,
  }
  if (commandId === undefined) return {
    label: '按此草稿再次执行',
    hint: '可能使用所选模型额度；若执行回执不确定，只检查原执行身份，不会自动再次提交。',
    hintTone: 'warning',
    disabled: false,
  }
  if (commandBusy) return {
    label: '正在检查执行…',
    hint: '只检查该次执行状态，不会再次提交。',
    hintTone: 'muted',
    disabled: true,
  }
  return {
    label: '检查该次执行状态',
    hint: '只检查该次执行状态，不会再次提交。',
    hintTone: 'muted',
    disabled: false,
  }
}

const NODE_TYPES = { 'studio-stage': WorkflowStageNode }
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu

function WorkflowStageNode({ data, isConnectable }: NodeProps<StudioFlowNode>): ReactElement {
  const { node, status } = data
  return createElement('div', { className: 'solar-workflow-studio__stage', 'data-status': status }, [
    createElement(Handle, { key: 'target', type: 'target', position: Position.Left, isConnectable }),
    createElement('strong', { key: 'label', className: 'solar-workflow-studio__stage-title' }, node.label.trim() || '未命名阶段'),
    createElement('span', { key: 'kind', className: 'solar-workflow-studio__stage-kind' }, nodeKindLabel(node.kind)),
    status === undefined
      ? null
      : createElement('span', { key: 'status', className: 'solar-workflow-studio__stage-kind' }, studioRunStatusLabel(status)),
    createElement(Handle, { key: 'source', type: 'source', position: Position.Right, isConnectable }),
  ])
}

function nodeKindLabel(kind: StudioNodeKind): string {
  const labels: Readonly<Record<StudioNodeKind, string>> = {
    native: '原生阶段',
    'chatgpt-web': 'ChatGPT 网页阶段',
    clarify: '澄清问题',
    'gemini-research': 'Gemini 研究',
    'gemini-thinking': 'Gemini 推理',
    'chatgpt-search': 'ChatGPT 搜索',
    'chatgpt-review': 'ChatGPT 审核',
    output: '交付输出',
  }
  return labels[kind]
}

function newId(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') throw new Error('当前界面无法生成一次性流程标识。')
  return globalThis.crypto.randomUUID()
}

function messageFor(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message.trim() : ''
  if (message.length === 0) return fallback
  return message.replace(UUID_PATTERN, '该记录')
}

function visibleError(value: string | undefined, fallback: string): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined
  return value.replace(UUID_PATTERN, '该记录') || fallback
}

function graphTitle(graph: StudioGraph): string {
  return graph.title.trim() || '未命名流程'
}

function timeLabel(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未提供' : date.toLocaleString('zh-CN')
}

function resumeKey(commandId: string, sourceId?: string): string {
  return sourceId === undefined ? `run:${commandId}` : `source:${sourceId}:${commandId}`
}

function currentDraftRun(
  draft: EditableStudioDraft | undefined,
  records: readonly StudioRunRecord[],
): StudioRunRecord | undefined {
  if (draft === undefined) return undefined
  const exact = [...records].reverse().find(record => (
    record.draftId === draft.id
    && record.draftRevision === draft.expectedRevision
    && record.graph.id === draft.graph.id
    && record.graph.sessionId === draft.graph.sessionId
    && record.run.sessionId === draft.graph.sessionId
  ))
  return exact !== undefined && sameExecutionGraph(draft.graph, exact.graph) ? exact : undefined
}

function workflowFlowNodes(graph: StudioGraph, run: StudioRun | undefined): StudioFlowNode[] {
  const statuses = new Map(run?.nodes.map(node => [node.nodeId, node.status]) ?? [])
  return graph.nodes.map(node => {
    const status = statuses.get(node.id)
    return {
    id: node.id,
    type: 'studio-stage',
    position: { x: node.position.x, y: node.position.y },
    data: { node, ...(status === undefined ? {} : { status }) },
  }
  })
}

function workflowFlowEdges(graph: StudioGraph): StudioFlowEdge[] {
  return graph.edges.map(edge => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: 'smoothstep',
    markerEnd: { type: MarkerType.ArrowClosed },
  }))
}

function replaceDraftRecord(overview: StudioOverview, draft: StudioDraft): StudioOverview {
  return { ...overview, drafts: upsertStudioDraft(overview.drafts, draft) }
}

function replaceRunRecord(overview: StudioOverview, record: StudioRunRecord): StudioOverview {
  return { ...overview, runs: upsertStudioRunRecord(overview.runs, record) }
}

function NodeJsonField({
  label,
  value,
  onCommit,
  validate,
}: {
  readonly label: string
  readonly value: JsonObject
  readonly onCommit: (value: JsonObject) => void
  readonly validate?: (value: JsonObject) => string | undefined
}): ReactElement {
  const rendered = formatJsonObject(value)
  const [text, setText] = useState(rendered)
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    setText(rendered)
    setError(undefined)
  }, [rendered])

  const commit = useCallback(() => {
    const parsed = parseJsonObject(text, label)
    if (parsed.error !== undefined || parsed.value === undefined) {
      setError(parsed.error ?? `${label}不是有效的 JSON 对象。`)
      return
    }
    const validationError = validate?.(parsed.value)
    if (validationError !== undefined) {
      setError(validationError)
      return
    }
    setError(undefined)
    onCommit(parsed.value)
  }, [label, onCommit, text, validate])

  return createElement('label', { className: 'solar-workflow-studio__field' }, [
    createElement('span', { key: 'label' }, label),
    createElement('textarea', {
      key: 'input',
      value: text,
      onChange: (event: ChangeEvent<HTMLTextAreaElement>) => setText(event.target.value),
      onBlur: commit,
      'aria-label': label,
      spellCheck: false,
    }),
    error === undefined ? null : createElement('span', { key: 'error', className: 'solar-workflow-studio__error', role: 'alert' }, error),
  ])
}

function NodeInspector({
  graph,
  node,
  onChange,
  onDelete,
}: {
  readonly graph: StudioGraph
  readonly node: StudioNode | undefined
  readonly onChange: (node: StudioNode) => void
  readonly onDelete: (node: StudioNode) => void
}): ReactElement {
  if (node === undefined) {
    return createElement('aside', { className: 'solar-workflow-studio__inspector' }, [
      createElement('h2', { key: 'title' }, '阶段属性'),
      createElement('p', { key: 'empty', className: 'solar-workflow-studio__muted' }, '点击画布中的阶段以编辑提示词、执行属性和元数据。'),
    ])
  }

  const properties = nodePropertyView(graph.providerId, node)
  const executorChoices = executorChoicesForProvider(graph.providerId, properties.executor)
  const showExecutor = graph.providerId === 'native' || properties.executor.length > 0 || properties.unsupported.includes('executor')
  const modelListId = `solar-studio-models-${graph.providerId}`
  const effortListId = 'solar-studio-efforts'
  const nodeKinds = nodeKindsForProvider(graph.providerId, node.kind)
  const isLocalOutput = node.kind === 'output'
  const promptLabel = isLocalOutput ? '交付排版模板' : '完整提示词'

  return createElement('aside', { className: 'solar-workflow-studio__inspector' }, [
    createElement('h2', { key: 'title' }, '阶段属性'),
    createElement('label', { key: 'label', className: 'solar-workflow-studio__field' }, [
      createElement('span', { key: 'caption' }, '名称'),
      createElement('input', {
        key: 'input',
        value: node.label,
        onChange: event => onChange({ ...node, label: event.target.value }),
        'aria-label': '阶段名称',
      }),
    ]),
    createElement('label', { key: 'kind', className: 'solar-workflow-studio__field' }, [
      createElement('span', { key: 'caption' }, '阶段类型'),
      createElement('select', {
        key: 'input',
        value: node.kind,
        onChange: (event: ChangeEvent<HTMLSelectElement>) => onChange({ ...node, kind: event.target.value as StudioNodeKind }),
        'aria-label': '阶段类型',
      }, nodeKinds.map(choice => createElement('option', { key: choice.value, value: choice.value }, choice.label))),
    ]),
    createElement('label', { key: 'prompt', className: 'solar-workflow-studio__field' }, [
      createElement('span', { key: 'caption' }, promptLabel),
      !isLocalOutput
        ? null
        : createElement('span', { key: 'hint', className: 'solar-workflow-studio__field-hint' }, '使用 {report} 放入完整报告；此节点只做本地排版，不调用模型。'),
      createElement('textarea', {
        key: 'input',
        value: node.prompt,
        onChange: (event: ChangeEvent<HTMLTextAreaElement>) => onChange({ ...node, prompt: event.target.value }),
        'aria-label': promptLabel,
        'data-prompt': 'true',
      }),
    ]),
    graph.providerId === 'native'
      ? null
      : createElement('label', { key: 'model-provider', className: 'solar-workflow-studio__field' }, [
        createElement('span', { key: 'caption' }, '模型服务'),
        createElement('select', {
          key: 'input',
          value: properties.modelProvider,
          onChange: (event: ChangeEvent<HTMLSelectElement>) => onChange(withProviderNodeStringProperty(node, graph.providerId, 'modelProvider', event.target.value)),
          'aria-label': '模型服务',
        }, [
          createElement('option', { key: 'empty', value: '' }, '请选择实际模型服务'),
          ...requestedProviderChoices(graph.providerId, properties.modelProvider)
            .map(choice => createElement('option', { key: choice.value, value: choice.value }, choice.label)),
        ]),
      ]),
    createElement('label', { key: 'model-id', className: 'solar-workflow-studio__field' }, [
      createElement('span', { key: 'caption' }, '模型标识'),
      createElement('input', {
        key: 'input',
        value: properties.modelId,
        list: modelListId,
        onChange: event => onChange(withProviderNodeStringProperty(node, graph.providerId, 'modelId', event.target.value)),
        'aria-label': '模型标识',
      }),
      createElement('datalist', { key: 'choices', id: modelListId }, modelChoicesForProvider(graph.providerId, properties.modelId)
        .map(choice => createElement('option', { key: choice.value, value: choice.value }, choice.label))),
    ]),
    createElement('label', { key: 'model-label', className: 'solar-workflow-studio__field' }, [
      createElement('span', { key: 'caption' }, '模型显示名称'),
      createElement('input', {
        key: 'input',
        value: properties.modelLabel,
        onChange: event => onChange(withProviderNodeStringProperty(node, graph.providerId, 'modelLabel', event.target.value)),
        'aria-label': '模型显示名称',
      }),
    ]),
    createElement('label', { key: 'effort', className: 'solar-workflow-studio__field' }, [
      createElement('span', { key: 'caption' }, '推理力度'),
      createElement('input', {
        key: 'input',
        value: properties.effortLabel,
        list: effortListId,
        onChange: event => onChange(withProviderNodeStringProperty(node, graph.providerId, 'effortLabel', event.target.value)),
        'aria-label': '推理力度',
      }),
      createElement('datalist', { key: 'choices', id: effortListId }, effortChoices(properties.effortLabel)
        .map(choice => createElement('option', { key: choice.value, value: choice.value }, choice.label))),
    ]),
    !showExecutor
      ? null
      : createElement('label', { key: 'executor', className: 'solar-workflow-studio__field' }, [
        createElement('span', { key: 'caption' }, graph.providerId === 'native' ? '原生执行器' : '执行器（当前流程值）'),
        createElement('input', {
          key: 'input',
          value: properties.executor,
          list: executorChoices.length === 0 ? undefined : `solar-studio-executors-${graph.providerId}`,
          onChange: event => onChange(withProviderNodeStringProperty(node, graph.providerId, 'executor', event.target.value)),
          'aria-label': '执行器',
        }),
        executorChoices.length === 0
          ? null
          : createElement('datalist', { key: 'choices', id: `solar-studio-executors-${graph.providerId}` }, executorChoices
            .map(choice => createElement('option', { key: choice.value, value: choice.value }, choice.label))),
      ]),
    properties.unsupported.length === 0
      ? null
      : createElement('p', { key: 'unsupported', className: 'solar-workflow-studio__error', role: 'alert' }, `当前流程的 ${properties.unsupported.join('、')} 不是文本；未修改该字段时会原样保留。`),
    createElement('details', { key: 'advanced', className: 'solar-workflow-studio__advanced-fields' }, [
      createElement('summary', { key: 'summary' }, '高级阶段参数'),
      createElement('div', { key: 'content', className: 'solar-workflow-studio__advanced-content' }, [
        createElement(NodeJsonField, {
          key: 'parameters',
          label: '其余参数 JSON',
          value: additionalNodeParametersForProvider(graph.providerId, node.parameters),
          validate: value => validateAdditionalNodeParametersForProvider(graph.providerId, value),
          onCommit: parameters => onChange(withAdditionalNodeParametersForProvider(node, graph.providerId, parameters)),
        }),
        createElement(NodeJsonField, {
          key: 'metadata',
          label: '元数据 JSON',
          value: node.metadata,
          onCommit: metadata => onChange({ ...node, metadata }),
        }),
      ]),
    ]),
    createElement('button', { key: 'delete', type: 'button', 'data-variant': 'danger', onClick: () => onDelete(node) }, '删除此阶段'),
  ])
}

function GraphInspector({ graph, onChange }: { readonly graph: StudioGraph; readonly onChange: (graph: StudioGraph) => void }): ReactElement {
  return createElement('section', { className: 'solar-workflow-studio__panel' }, [
    createElement('h2', { key: 'title' }, '流程属性'),
    createElement('label', { key: 'name', className: 'solar-workflow-studio__field' }, [
      createElement('span', { key: 'caption' }, '流程名称'),
      createElement('input', {
        key: 'input',
        value: graph.title,
        onChange: event => onChange(withStudioGraphTitle(graph, event.target.value)),
        'aria-label': '流程名称',
      }),
    ]),
    createElement('details', { key: 'advanced', className: 'solar-workflow-studio__advanced-fields' }, [
      createElement('summary', { key: 'summary' }, '高级流程参数'),
      createElement('div', { key: 'content', className: 'solar-workflow-studio__advanced-content' }, [
        createElement(NodeJsonField, {
          key: 'parameters',
          label: '流程参数 JSON',
          value: graph.parameters,
          onCommit: parameters => onChange(withStudioGraphParameters(graph, parameters)),
        }),
        createElement(NodeJsonField, {
          key: 'metadata',
          label: '流程元数据 JSON',
          value: graph.metadata,
          onCommit: metadata => onChange(withStudioGraphMetadata(graph, metadata)),
        }),
      ]),
    ]),
  ])
}

function FlowSources({
  overview,
  draft,
  onFork,
  onChooseDraft,
}: {
  readonly overview: StudioOverview | undefined
  readonly draft: EditableStudioDraft | undefined
  readonly onFork: (source: StudioSource) => void
  readonly onChooseDraft: (draft: StudioDraft) => void
}): ReactElement {
  const sources = overview?.sources ?? []
  const drafts = overview?.drafts ?? []
  const choosing = draft === undefined
  const currentTitle = choosing ? '选择来源流程或已保存草稿' : graphTitle(draft.graph)
  return createElement('details', {
    className: 'solar-workflow-studio__flow-picker',
    open: choosing,
    'aria-label': choosing ? '选择来源流程或已保存草稿' : '切换当前草稿',
  }, [
    createElement('summary', { key: 'summary', className: 'solar-workflow-studio__flow-picker-summary' }, [
      createElement('span', { key: 'label', className: 'solar-workflow-studio__muted' }, choosing ? '选择流程' : '切换流程'),
      choosing ? createElement('strong', { key: 'title' }, currentTitle) : null,
      createElement('span', { key: 'counts', className: 'solar-workflow-studio__muted' }, `来源流程 ${sources.length} · 已保存草稿 ${drafts.length}`),
    ]),
    createElement('div', { key: 'content', className: 'solar-workflow-studio__flow-picker-content' }, [
      createElement('div', { key: 'sources', className: 'solar-workflow-studio__list' }, [
      createElement('strong', { key: 'heading' }, '来源流程'),
      createElement('p', { key: 'description', className: 'solar-workflow-studio__muted' }, '选择来源会基于原流程建立草稿；修改草稿不会影响原执行。保存后才可执行。'),
      sources.length === 0
        ? createElement('span', { key: 'empty', className: 'solar-workflow-studio__muted' }, '当前会话暂无来源流程。')
        : sources.map(source => createElement('button', {
          key: source.id,
          type: 'button',
          onClick: () => onFork(source),
          className: draft?.sourceId === source.id ? 'solar-workflow-studio__selected' : undefined,
          'aria-pressed': draft?.sourceId === source.id,
        }, `以“${graphTitle(source.graph)}”建立草稿`)),
    ]),
    createElement('div', { key: 'drafts', className: 'solar-workflow-studio__list' }, [
      createElement('strong', { key: 'heading' }, '已保存草稿'),
      createElement('p', { key: 'description', className: 'solar-workflow-studio__muted' }, '选择草稿以继续编辑；执行始终使用其精确保存版本。'),
      drafts.length === 0
        ? createElement('span', { key: 'empty', className: 'solar-workflow-studio__muted' }, '当前会话没有已保存草稿。')
        : drafts.map(saved => createElement('button', {
          key: saved.id,
          type: 'button',
          onClick: () => onChooseDraft(saved),
          className: draft?.id === saved.id ? 'solar-workflow-studio__selected' : undefined,
          'aria-pressed': draft?.id === saved.id,
        }, `编辑“${graphTitle(saved.graph)}” · 版本 ${saved.revision}`)),
    ]),
    ]),
  ])
}

function RunList({ records, onInspect, onResume, busyCommands, resumingCommands, resumeDisabled }: {
  readonly records: readonly StudioRunRecord[]
  readonly onInspect: (commandId: string) => void
  readonly onResume: (commandId: string) => void
  readonly busyCommands: ReadonlySet<string>
  readonly resumingCommands: ReadonlySet<string>
  readonly resumeDisabled: boolean
}): ReactElement {
  return createElement('section', { className: 'solar-workflow-studio__run-list' }, [
    createElement('h2', { key: 'title' }, '执行记录'),
    createElement('p', { key: 'description', className: 'solar-workflow-studio__muted' }, '执行记录保留当时的草稿快照；检查只读取同一执行身份，不会再次提交。'),
    records.length === 0
      ? createElement('p', { key: 'empty', className: 'solar-workflow-studio__muted' }, '当前会话尚无执行记录。')
      : [...records].reverse().map(record => {
        const resumable = canResumeStudioRun(record.graph.providerId, record.commandId, record.run)
        const pendingResume = resumingCommands.has(resumeKey(record.commandId))
        return createElement('article', { key: record.commandId, className: 'solar-workflow-studio__run-card' }, [
          createElement('strong', { key: 'title' }, graphTitle(record.graph)),
          createElement('span', { key: 'status', className: 'solar-workflow-studio__status', 'data-status': record.run.status }, studioRunStatusLabel(record.run.status)),
          createElement('span', { key: 'time', className: 'solar-workflow-studio__muted' }, `更新于 ${timeLabel(record.run.updatedAt)}`),
          createElement('button', {
            key: 'inspect',
            type: 'button',
            disabled: busyCommands.has(record.commandId) || pendingResume,
            onClick: () => onInspect(record.commandId),
          }, busyCommands.has(record.commandId) ? '正在检查…' : '检查此执行状态'),
          !resumable
            ? null
            : createElement('div', { key: 'resume', className: 'solar-workflow-studio__resume-action' }, [
              createElement('button', {
                key: 'action',
                type: 'button',
                'data-variant': 'primary',
                disabled: resumeDisabled || pendingResume || busyCommands.has(record.commandId),
                onClick: () => onResume(record.commandId),
              }, pendingResume ? '正在继续原执行…' : '继续原执行（可能使用额度）'),
              createElement('span', { key: 'hint', className: 'solar-workflow-studio__quota-warning' }, '可能使用所选模型额度；只推进未执行阶段，不创建替代执行。'),
            ]),
        ])
      }),
  ])
}

function RunEvidencePanel({
  title,
  description,
  graph,
  run,
  selectedNodeId,
  resume,
  onResume,
  resuming,
  resumeDisabled,
}: {
  readonly title: string
  readonly description: string
  readonly graph: StudioGraph
  readonly run: StudioRun | undefined
  readonly selectedNodeId: string | undefined
  readonly resume?: { readonly commandId: string; readonly sourceId?: string }
  readonly onResume?: (commandId: string, sourceId?: string) => void
  readonly resuming?: boolean
  readonly resumeDisabled?: boolean
}): ReactElement {
  const byNode = new Map(run?.nodes.map(node => [node.nodeId, node]) ?? [])
  const selected = selectedNodeId === undefined ? undefined : byNode.get(selectedNodeId)
  return createElement('section', { className: 'solar-workflow-studio__panel solar-workflow-studio__evidence' }, [
    createElement('h2', { key: 'title' }, title),
    run === undefined
      ? createElement('p', { key: 'empty', className: 'solar-workflow-studio__muted' }, '尚未观察到这份流程版本的执行结果。')
      : [
        createElement('span', { key: 'status', className: 'solar-workflow-studio__status', 'data-status': run.status }, studioRunStatusLabel(run.status)),
        resume === undefined || onResume === undefined
          ? null
          : createElement('div', { key: 'resume', className: 'solar-workflow-studio__resume-action' }, [
            createElement('button', {
              key: 'action',
              type: 'button',
              'data-variant': 'primary',
              disabled: resumeDisabled === true || resuming === true,
              onClick: () => onResume(resume.commandId, resume.sourceId),
            }, resuming === true ? '正在继续原执行…' : '继续原执行（可能使用额度）'),
            createElement('span', { key: 'hint', className: 'solar-workflow-studio__quota-warning' }, '可能使用所选模型额度；会先核对原请求，再继续未执行阶段，仍使用原执行身份。'),
          ]),
        createElement('details', { key: 'details', className: 'solar-workflow-studio__evidence-details' }, [
          createElement('summary', { key: 'summary' }, '查看阶段状态与输出'),
          createElement('p', { key: 'description', className: 'solar-workflow-studio__muted' }, description),
          createElement('div', { key: 'nodes', className: 'solar-workflow-studio__list' }, graph.nodes.map(node => {
            const result = byNode.get(node.id)
            return createElement('span', { key: node.id, className: 'solar-workflow-studio__muted' }, `${node.label.trim() || '未命名阶段'}：${result === undefined ? '未返回阶段结果' : studioRunStatusLabel(result.status)}`)
          })),
          selected?.output === undefined
            ? null
            : createElement('pre', { key: 'output', className: 'solar-workflow-studio__result' }, selected.output),
          selected?.error === undefined
            ? null
            : createElement('pre', { key: 'error', className: 'solar-workflow-studio__result solar-workflow-studio__error' }, selected.error),
          run.output === undefined
            ? null
            : createElement('pre', { key: 'run-output', className: 'solar-workflow-studio__result' }, run.output),
          ]),
      ],
  ])
}

/**
 * Current-session flow editor. It owns only browser-local editing state and
 * reaches durable data through the public StudioUiApi supplied by the host.
 */
export function WorkflowStudioPanel({ sessionId, api, error }: WorkflowStudioPanelProps): ReactElement {
  const [overview, setOverview] = useState<StudioOverview | undefined>()
  const [draft, setDraft] = useState<EditableStudioDraft | undefined>()
  const [dirty, setDirty] = useState(false)
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>()
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | undefined>()
  const [notice, setNotice] = useState<Notice | undefined>()
  const [issues, setIssues] = useState<readonly string[]>([])
  const [loading, setLoading] = useState(false)
  const [overviewError, setOverviewError] = useState<string | undefined>()
  const [saving, setSaving] = useState(false)
  const [busyCommands, setBusyCommands] = useState<ReadonlySet<string>>(() => new Set())
  const [resumingCommands, setResumingCommands] = useState<ReadonlySet<string>>(() => new Set())
  const [pendingCommands, setPendingCommands] = useState<Readonly<Record<string, PendingCommand>>>({})
  const activeSessionRef = useRef(sessionId)
  const overviewRequestRef = useRef(0)
  const draftGenerationRef = useRef(0)
  const initialSelectionEpochRef = useRef(0)
  const draftRef = useRef<EditableStudioDraft | undefined>()
  const dirtyRef = useRef(false)
  const actionLocks = useRef(new Set<string>())
  activeSessionRef.current = sessionId
  draftRef.current = draft
  dirtyRef.current = dirty

  const isCurrent = useCallback((requestedSessionId: string): boolean => requestedSessionId === activeSessionRef.current, [])

  const withCommandBusy = useCallback((commandId: string, busy: boolean): void => {
    setBusyCommands(current => {
      const next = new Set(current)
      if (busy) next.add(commandId)
      else next.delete(commandId)
      return next
    })
  }, [])

  const withResumeBusy = useCallback((key: string, busy: boolean): void => {
    setResumingCommands(current => {
      const next = new Set(current)
      if (busy) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])

  const lock = useCallback((key: string): boolean => {
    if (actionLocks.current.has(key)) return false
    actionLocks.current.add(key)
    return true
  }, [])

  const unlock = useCallback((key: string): void => { actionLocks.current.delete(key) }, [])

  const reload = useCallback(async (announce: boolean, initialSelectionEpoch?: number): Promise<void> => {
    if (api === undefined) return
    const requestedSessionId = sessionId
    const requestId = ++overviewRequestRef.current
    const initialGeneration = draftGenerationRef.current
    setLoading(true)
    setOverviewError(undefined)
    try {
      const next = await api.overview({ sessionId: requestedSessionId })
      if (requestId !== overviewRequestRef.current || !isCurrentStudioOverview(requestedSessionId, activeSessionRef.current, next)) return
      setOverview(next)
      if (
        initialSelectionEpoch !== undefined
        && initialSelectionEpoch === initialSelectionEpochRef.current
        && initialGeneration === draftGenerationRef.current
        && draftRef.current === undefined
        && !dirtyRef.current
      ) {
        const selection = initialStudioSelection(next)
        if (selection !== undefined) {
          try {
            const selected = selection.kind === 'source'
              ? forkStudioSource(selection.source, newId())
              : editableStudioDraft(selection.draft)
            const selectedDirty = selection.kind === 'source'
            draftGenerationRef.current += 1
            draftRef.current = selected
            dirtyRef.current = selectedDirty
            setDraft(selected)
            setDirty(selectedDirty)
          } catch (caught) {
            setNotice({ tone: 'error', message: messageFor(caught, '无法载入当前会话流程。') })
          }
        }
      }
      if (announce) setNotice({ tone: 'info', message: '已读取当前会话流程；刷新没有提交模型请求。' })
    } catch (caught) {
      if (requestId === overviewRequestRef.current && isCurrent(requestedSessionId)) {
        const message = messageFor(caught, '请求未完成。')
        setOverviewError(message)
        setNotice({ tone: 'error', message: `无法读取当前会话流程：${message}` })
      }
    } finally {
      if (requestId === overviewRequestRef.current && isCurrent(requestedSessionId)) setLoading(false)
    }
  }, [api, isCurrent, sessionId])

  const refreshCurrentFlow = useCallback(async (): Promise<void> => {
    if (api === undefined) return
    const sourceId = draft?.sourceId
    if (sourceId === undefined) {
      await reload(true)
      return
    }
    const requestedSessionId = sessionId
    setLoading(true)
    try {
      const refreshed = await api.refreshSource({ sessionId: requestedSessionId, sourceId })
      if (!isCurrent(requestedSessionId) || refreshed.id !== sourceId || !isCurrentStudioSource(requestedSessionId, refreshed)) return
      setOverview(current => current === undefined || current.sessionId !== requestedSessionId
        ? current
        : { ...current, sources: upsertStudioSource(current.sources, refreshed) })
      setNotice({ tone: 'info', message: '已检查来源流程的原执行状态；此操作没有提交新的模型请求。' })
    } catch (caught) {
      if (isCurrent(requestedSessionId)) setNotice({ tone: 'error', message: `无法检查来源流程：${messageFor(caught, '请求未完成。')}` })
    } finally {
      if (isCurrent(requestedSessionId)) setLoading(false)
    }
  }, [api, draft?.sourceId, isCurrent, reload, sessionId])

  useEffect(() => {
    overviewRequestRef.current += 1
    draftGenerationRef.current += 1
    const initialSelectionEpoch = ++initialSelectionEpochRef.current
    draftRef.current = undefined
    dirtyRef.current = false
    setOverview(undefined)
    setDraft(undefined)
    setDirty(false)
    setSelectedNodeId(undefined)
    setSelectedEdgeId(undefined)
    setIssues([])
    setNotice(undefined)
    setOverviewError(undefined)
    setPendingCommands({})
    setBusyCommands(new Set())
    setResumingCommands(new Set())
    if (api !== undefined) void reload(false, initialSelectionEpoch)
  }, [api, reload, sessionId])

  const changeDraft = useCallback((change: (graph: StudioGraph) => StudioGraph): void => {
    setDraft(current => {
      if (current === undefined) return current
      draftGenerationRef.current += 1
      const next = { ...current, graph: change(current.graph) }
      draftRef.current = next
      return next
    })
    dirtyRef.current = true
    setDirty(true)
    setIssues([])
  }, [])

  const selectSource = useCallback((source: StudioSource): void => {
    try {
      const selected = forkStudioSource(source, newId())
      draftGenerationRef.current += 1
      draftRef.current = selected
      dirtyRef.current = true
      setDraft(selected)
      setDirty(true)
      setSelectedNodeId(undefined)
      setSelectedEdgeId(undefined)
      setIssues([])
      setNotice({ tone: 'info', message: '已建立新草稿。请保存后再执行；此操作没有提交模型请求。' })
    } catch (caught) {
      setNotice({ tone: 'error', message: messageFor(caught, '无法建立新草稿。') })
    }
  }, [])

  const selectDraft = useCallback((saved: StudioDraft): void => {
    const selected = editableStudioDraft(saved)
    draftGenerationRef.current += 1
    draftRef.current = selected
    dirtyRef.current = false
    setDraft(selected)
    setDirty(false)
    setSelectedNodeId(undefined)
    setSelectedEdgeId(undefined)
    setIssues([])
    setNotice({ tone: 'info', message: '已载入已保存草稿。编辑尚不会提交模型请求。' })
  }, [])

  const saveDraft = useCallback(async (): Promise<void> => {
    if (api === undefined || draft === undefined || saving) return
    const requestedSessionId = sessionId
    const captured = draft
    const generation = draftGenerationRef.current
    setSaving(true)
    setIssues([])
    try {
      const found = await api.validate({ sessionId: requestedSessionId, graph: captured.graph })
      if (!isCurrent(requestedSessionId) || draftGenerationRef.current !== generation) return
      if (found.length > 0) {
        setIssues(found.map(issue => issue.message))
        setNotice({ tone: 'error', message: '流程未保存：请先修正列出的字段。' })
        return
      }
      const saved = await api.save({
        sessionId: requestedSessionId,
        id: captured.id,
        expectedRevision: captured.expectedRevision,
        graph: captured.graph,
        ...(captured.sourceId === undefined ? {} : { sourceId: captured.sourceId }),
      })
      if (!isCurrent(requestedSessionId) || draftGenerationRef.current !== generation || saved.graph.sessionId !== requestedSessionId) return
      const selected = editableStudioDraft(saved)
      draftRef.current = selected
      dirtyRef.current = false
      setDraft(selected)
      setDirty(false)
      setOverview(current => current === undefined || current.sessionId !== requestedSessionId ? current : replaceDraftRecord(current, saved))
      setNotice({ tone: 'info', message: '草稿已按当前版本保存。' })
    } catch (caught) {
      if (isCurrent(requestedSessionId)) setNotice({ tone: 'error', message: `无法保存草稿：${messageFor(caught, '请求未完成。')}` })
    } finally {
      if (isCurrent(requestedSessionId)) setSaving(false)
    }
  }, [api, draft, isCurrent, saving, sessionId])

  const inspectRun = useCallback(async (commandId: string): Promise<void> => {
    if (api === undefined || !lock(`inspect:${commandId}`)) return
    const requestedSessionId = sessionId
    withCommandBusy(commandId, true)
    try {
      const record = await api.inspect({ sessionId: requestedSessionId, commandId })
      if (!isCurrent(requestedSessionId) || record.commandId !== commandId || !isCurrentStudioRunRecord(requestedSessionId, record)) {
        if (isCurrent(requestedSessionId)) setNotice({ tone: 'error', message: '执行状态回执与原请求不一致；请继续检查原执行身份。' })
        return
      }
      setOverview(current => current === undefined || current.sessionId !== requestedSessionId ? current : replaceRunRecord(current, record))
      if (isTerminalStudioRun(record.run.status)) {
        setPendingCommands(current => {
          const entry = current[record.draftId]
          if (entry?.commandId !== record.commandId) return current
          const next = { ...current }
          delete next[record.draftId]
          return next
        })
      }
      setNotice({ tone: 'info', message: `已读取该次执行状态：${studioRunStatusLabel(record.run.status)}。` })
    } catch (caught) {
      if (isCurrent(requestedSessionId)) setNotice({ tone: 'error', message: `无法确认该次执行状态：${messageFor(caught, '请求未完成。')}` })
    } finally {
      if (isCurrent(requestedSessionId)) withCommandBusy(commandId, false)
      unlock(`inspect:${commandId}`)
    }
  }, [api, isCurrent, lock, sessionId, unlock, withCommandBusy])

  const resumeOriginalRun = useCallback(async (commandId: string, sourceId?: string): Promise<void> => {
    if (api === undefined) return
    const key = resumeKey(commandId, sourceId)
    if (!lock(`resume:${key}`)) return
    const requestedSessionId = sessionId
    withResumeBusy(key, true)
    setNotice({ tone: 'info', message: '正在继续原执行；会先核对原请求，再推进未执行阶段，可能使用模型额度。' })
    try {
      const run = await api.resume({
        sessionId: requestedSessionId,
        commandId,
        ...(sourceId === undefined ? {} : { sourceId }),
      })
      if (!isCurrent(requestedSessionId)) return
      if (run.id !== commandId || run.sessionId !== requestedSessionId) {
        setNotice({ tone: 'error', message: '继续执行回执与原执行身份不一致；界面不会创建新的执行。' })
        return
      }
      await reload(false)
    } catch (caught) {
      if (isCurrent(requestedSessionId)) setNotice({ tone: 'error', message: `无法继续原执行：${messageFor(caught, '请求未完成。')}` })
    } finally {
      if (isCurrent(requestedSessionId)) withResumeBusy(key, false)
      unlock(`resume:${key}`)
    }
  }, [api, isCurrent, lock, reload, sessionId, unlock, withResumeBusy])

  const runDraft = useCallback(async (): Promise<void> => {
    if (api === undefined || draft === undefined) return
    const pending = pendingCommands[draft.id]
    const pendingCommandId = pending?.revision === draft.expectedRevision ? pending.commandId : undefined
    const commandId = currentCommandForDraft(draft.id, overview?.runs ?? [], pendingCommandId, draft.expectedRevision)
    let decision
    try {
      decision = decideStudioRunAction({
        dirty,
        ...(commandId === undefined ? {} : { pendingCommandId: commandId }),
        createCommandId: newId,
      })
    } catch (caught) {
      setNotice({ tone: 'error', message: messageFor(caught, '无法生成执行身份。') })
      return
    }
    if (decision.kind === 'save-required') {
      setNotice({ tone: 'error', message: '此草稿有未保存修改。请先保存，再执行该草稿。' })
      return
    }
    if (decision.kind === 'inspect') {
      void inspectRun(decision.commandId)
      return
    }
    if (!lock(`run:${draft.id}`)) return
    const requestedSessionId = sessionId
    const captured = draft
    const capturedGeneration = draftGenerationRef.current
    const requestedCommandId = decision.commandId
    withCommandBusy(requestedCommandId, true)
    setNotice({ tone: 'info', message: '正在按此草稿提交一次新执行。该操作会使用所选模型的可用额度。' })
    try {
      const record = await api.run({
        sessionId: requestedSessionId,
        draftId: captured.id,
        expectedRevision: captured.expectedRevision,
        commandId: requestedCommandId,
      })
      if (!isCurrent(requestedSessionId) || !isCurrentStudioRunRecord(requestedSessionId, record)) return
      if (record.commandId !== requestedCommandId) {
        setPendingCommands(current => ({ ...current, [captured.id]: { commandId: requestedCommandId, revision: captured.expectedRevision } }))
        setNotice({ tone: 'error', message: '执行回执与原请求不一致；请检查原执行状态，界面不会自动再次提交。' })
        return
      }
      setOverview(current => current === undefined || current.sessionId !== requestedSessionId ? current : replaceRunRecord(current, record))
      if (isTerminalStudioRun(record.run.status)) {
        setPendingCommands(current => {
          if (current[captured.id]?.commandId !== requestedCommandId) return current
          const next = { ...current }
          delete next[captured.id]
          return next
        })
      } else {
        setPendingCommands(current => ({ ...current, [captured.id]: { commandId: requestedCommandId, revision: captured.expectedRevision } }))
      }
      if (draftGenerationRef.current === capturedGeneration) setNotice({ tone: 'info', message: `已收到该次执行回执：${studioRunStatusLabel(record.run.status)}。` })
    } catch (caught) {
      if (isCurrent(requestedSessionId)) {
        setPendingCommands(current => ({ ...current, [captured.id]: { commandId: requestedCommandId, revision: captured.expectedRevision } }))
        setNotice({ tone: 'error', message: `执行结果未确认：${messageFor(caught, '请检查原执行状态。')} 界面不会自动再次提交。` })
      }
    } finally {
      if (isCurrent(requestedSessionId)) withCommandBusy(requestedCommandId, false)
      unlock(`run:${captured.id}`)
    }
  }, [api, dirty, draft, inspectRun, isCurrent, lock, overview?.runs, pendingCommands, sessionId, unlock, withCommandBusy])

  const addNode = useCallback((): void => {
    if (draft === undefined) return
    try {
      const node = nextStudioNode(draft.graph, newId())
      changeDraft(graph => withStudioNodeAdded(graph, node))
      setSelectedNodeId(node.id)
    } catch (caught) {
      setNotice({ tone: 'error', message: messageFor(caught, '无法新增阶段。') })
    }
  }, [changeDraft, draft])

  const graph = draft?.graph
  const selectedNode = useMemo(() => graph?.nodes.find(node => node.id === selectedNodeId), [graph, selectedNodeId])
  const sourceForDraft = useMemo(
    () => draft?.sourceId === undefined ? undefined : overview?.sources.find(source => source.id === draft.sourceId),
    [draft?.sourceId, overview?.sources],
  )
  const sourceMatchesDraft = useMemo(
    () => draft !== undefined && sourceForDraft !== undefined && sameExecutionGraph(draft.graph, sourceForDraft.graph),
    [draft, sourceForDraft],
  )
  const sourceRun = useMemo(() => sourceExecutionRun(draft, sourceForDraft), [draft, sourceForDraft])
  const draftRun = useMemo(() => currentDraftRun(draft, overview?.runs ?? []), [draft, overview?.runs])
  const sourceResume = sourceForDraft !== undefined && canResumeStudioRun(sourceForDraft.graph.providerId, sourceForDraft.runId, sourceForDraft.run)
    ? { commandId: sourceForDraft.runId!, sourceId: sourceForDraft.id }
    : undefined
  const displayedRun = draftRun?.run ?? sourceRun
  const executionStateLabel = draftRun !== undefined
    ? '当前草稿执行状态（已保存版本）'
    : sourceRun !== undefined
      ? '来源执行状态（对应原内容）'
      : draft?.sourceId !== undefined && sourceForDraft !== undefined && !sourceMatchesDraft
        ? '草稿已修改，尚未执行'
        : undefined
  const flowNodes = useMemo(() => graph === undefined ? [] : workflowFlowNodes(graph, displayedRun), [displayedRun, graph])
  const flowEdges = useMemo(() => graph === undefined ? [] : workflowFlowEdges(graph), [graph])
  const currentPending = draft === undefined ? undefined : pendingCommands[draft.id]
  const currentCommandId = draft === undefined
    ? undefined
    : currentCommandForDraft(
      draft.id,
      overview?.runs ?? [],
      currentPending?.revision === draft.expectedRevision ? currentPending.commandId : undefined,
      draft.expectedRevision,
    )
  const serviceError = visibleError(error, '流程服务暂不可用。')
  const presentation = workflowStudioPresentation({
    overview,
    draft,
    loading,
    apiAvailable: api !== undefined,
    hasServiceError: serviceError !== undefined,
    hasOverviewError: overviewError !== undefined,
  })
  const draftSaveStatus = studioDraftSaveStatus(draft, overview, dirty)
  const draftPersisted = draftSaveStatus?.startsWith('已保存') ?? false
  const runRecords = overview?.runs ?? []
  const runAction = workflowStudioRunAction(
    dirty,
    currentCommandId,
    currentCommandId !== undefined && busyCommands.has(currentCommandId),
  )
  const unavailableMessage = api === undefined
    ? '流程服务尚未连接，当前无法读取或编辑此会话的执行流程。'
    : serviceError ?? overviewError ?? '当前无法读取会话执行流程。'

  return createElement('main', { className: 'solar-workflow-studio' }, [
    createElement(WorkflowStudioStyles, { key: 'styles' }),
    createElement('header', { key: 'intro', className: 'solar-workflow-studio__intro' }, [
      createElement('h1', { key: 'title' }, '执行流程'),
      createElement('p', { key: 'summary', className: 'solar-workflow-studio__muted' }, '用于查看本会话任务步骤并调整草稿；普通聊天不必创建流程。'),
      serviceError === undefined ? null : createElement('p', { key: 'error', className: 'solar-workflow-studio__error', role: 'alert' }, serviceError),
      notice === undefined ? null : createElement('p', { key: 'notice', className: notice.tone === 'error' ? 'solar-workflow-studio__error' : 'solar-workflow-studio__success', role: notice.tone === 'error' ? 'alert' : 'status' }, notice.message),
      issues.length === 0 ? null : createElement('ul', { key: 'issues', className: 'solar-workflow-studio__error' }, issues.map((issue, index) => createElement('li', { key: `${index}:${issue}` }, issue))),
    ]),
    presentation === 'loading'
      ? createElement('section', { key: 'loading', className: 'solar-workflow-studio__empty-state', 'aria-live': 'polite' }, [
        createElement('h2', { key: 'title' }, '正在读取当前会话流程'),
        createElement('p', { key: 'message', className: 'solar-workflow-studio__muted' }, '读取完成后会显示当前会话的任务步骤或已保存草稿。'),
      ])
      : presentation === 'unavailable'
        ? createElement('section', { key: 'unavailable', className: 'solar-workflow-studio__empty-state' }, [
          createElement('h2', { key: 'title' }, '当前无法读取执行流程'),
          createElement('p', { key: 'message', className: 'solar-workflow-studio__muted' }, unavailableMessage),
          api === undefined || serviceError !== undefined
            ? null
            : createElement('button', { key: 'refresh', type: 'button', onClick: () => { void refreshCurrentFlow() } }, '刷新当前会话流程'),
        ])
        : presentation === 'empty'
          ? createElement('section', { key: 'empty', className: 'solar-workflow-studio__empty-state' }, [
            createElement('h2', { key: 'title' }, '当前会话还没有执行流程'),
            createElement('p', { key: 'message', className: 'solar-workflow-studio__muted' }, '当前会话还没有可查看的任务步骤。刷新可读取当前会话中新出现的来源流程或已保存草稿。'),
            createElement('button', { key: 'refresh', type: 'button', disabled: loading, onClick: () => { void refreshCurrentFlow() } }, loading ? '正在刷新…' : '刷新当前会话流程'),
          ])
          : presentation === 'selection'
            ? createElement(FlowSources, { key: 'sources', overview, draft, onFork: selectSource, onChooseDraft: selectDraft })
            : graph === undefined
              ? null
              : [
                createElement(FlowSources, { key: 'sources', overview, draft, onFork: selectSource, onChooseDraft: selectDraft }),
                createElement('section', { key: 'draft-summary', className: 'solar-workflow-studio__draft-summary' }, [
                  createElement('div', { key: 'identity' }, [
                    createElement('span', { key: 'label', className: 'solar-workflow-studio__muted' }, '正在编辑草稿'),
                    createElement('h2', { key: 'title' }, graphTitle(graph)),
                    createElement('p', { key: 'status', className: 'solar-workflow-studio__draft-status', 'data-state': draftPersisted ? 'saved' : 'unsaved', role: 'status' }, draftSaveStatus),
                  ]),
                  createElement('p', { key: 'hint', className: 'solar-workflow-studio__muted' }, '编辑和保存不会启动模型。'),
                ]),
                createElement('section', { key: 'toolbar', className: 'solar-workflow-studio__toolbar', 'aria-label': '流程操作' }, [
                  createElement('div', { key: 'observe', className: 'solar-workflow-studio__toolbar-group', 'aria-label': '读取流程状态' }, [
                    createElement('button', { key: 'refresh', type: 'button', disabled: api === undefined || loading, onClick: () => { void refreshCurrentFlow() } }, loading ? '正在刷新…' : draft?.sourceId === undefined ? '刷新当前会话' : '检查来源流程'),
                  ]),
                  createElement('div', { key: 'edit', className: 'solar-workflow-studio__toolbar-group', 'aria-label': '编辑草稿' }, [
                    createElement('button', { key: 'add', type: 'button', onClick: addNode }, '新增阶段'),
                    createElement('button', {
                      key: 'delete-edge',
                      type: 'button',
                      'data-variant': 'danger',
                      disabled: selectedEdgeId === undefined,
                      onClick: () => {
                        if (selectedEdgeId === undefined) return
                        changeDraft(current => withoutStudioEdges(current, new Set([selectedEdgeId])))
                        setSelectedEdgeId(undefined)
                      },
                    }, '删除选中依赖'),
                  ]),
                  createElement('div', { key: 'save', className: 'solar-workflow-studio__toolbar-group', 'aria-label': '保存草稿' }, [
                    createElement('button', { key: 'action', type: 'button', 'data-variant': 'primary', disabled: api === undefined || saving, onClick: () => { void saveDraft() } }, saving ? '正在保存…' : '保存草稿'),
                  ]),
                  createElement('div', { key: 'run', className: 'solar-workflow-studio__toolbar-group solar-workflow-studio__execution-action', 'aria-label': '执行草稿' }, [
                    createElement('button', {
                      key: 'action',
                      type: 'button',
                      'data-variant': 'primary',
                      disabled: api === undefined || runAction.disabled,
                      onClick: () => { void runDraft() },
                    }, runAction.label),
                    createElement('span', { key: 'hint', className: runAction.hintTone === 'warning' ? 'solar-workflow-studio__quota-warning' : 'solar-workflow-studio__muted' }, runAction.hint),
                  ]),
                ]),
                createElement('div', { key: 'layout', className: 'solar-workflow-studio__layout' }, [
        createElement('div', { key: 'canvas-column', className: 'solar-workflow-studio__canvas-column' }, [
          createElement('div', { key: 'canvas', className: 'solar-workflow-studio__canvas' }, createElement(ReactFlow<StudioFlowNode, StudioFlowEdge>, {
            nodes: flowNodes,
            edges: flowEdges,
            nodeTypes: NODE_TYPES,
            fitView: true,
            minZoom: 0.2,
            maxZoom: 2,
            onNodeClick: (_event, node) => {
              setSelectedNodeId(node.id)
              setSelectedEdgeId(undefined)
            },
            onEdgeClick: (_event, edge) => {
              setSelectedEdgeId(edge.id)
              setSelectedNodeId(undefined)
            },
            onPaneClick: () => {
              setSelectedNodeId(undefined)
              setSelectedEdgeId(undefined)
            },
            onNodeDragStop: (_event, node) => changeDraft(current => withStudioNodePosition(current, node.id, node.position)),
            onNodesDelete: nodes => {
              const nodeIds = new Set(nodes.map(node => node.id))
              changeDraft(current => withoutStudioNodes(current, nodeIds))
              if (selectedNodeId !== undefined && nodeIds.has(selectedNodeId)) setSelectedNodeId(undefined)
              setSelectedEdgeId(undefined)
            },
            onEdgesDelete: edges => {
              const edgeIds = new Set(edges.map(edge => edge.id))
              changeDraft(current => withoutStudioEdges(current, edgeIds))
              if (selectedEdgeId !== undefined && edgeIds.has(selectedEdgeId)) setSelectedEdgeId(undefined)
            },
            isValidConnection: connection => connection.source !== null && connection.target !== null && canAddStudioEdge(graph, connection.source, connection.target),
            onConnect: (connection: Connection) => {
              if (connection.source === null || connection.target === null) return
              if (!canAddStudioEdge(graph, connection.source, connection.target)) {
                setNotice({ tone: 'error', message: '该依赖会重复、引用不存在的阶段或形成循环，未加入流程。' })
                return
              }
              try {
                const id = newId()
                changeDraft(current => withStudioEdgeAdded(current, { id, source: connection.source!, target: connection.target! }))
                setSelectedEdgeId(id)
              } catch (caught) {
                setNotice({ tone: 'error', message: messageFor(caught, '无法新增依赖。') })
              }
            },
          }, [
            createElement(Background, { key: 'background', gap: 18, size: 1 }),
            createElement(Controls, { key: 'controls', showInteractive: false }),
          ])),
          executionStateLabel === undefined
            ? null
            : createElement('p', { key: 'execution-state', className: executionStateLabel === '草稿已修改，尚未执行' ? 'solar-workflow-studio__error' : 'solar-workflow-studio__success', role: 'status' }, executionStateLabel),
          createElement(GraphInspector, { key: 'graph-inspector', graph, onChange: next => changeDraft(() => next) }),
          sourceForDraft?.run === undefined
            ? null
            : createElement(RunEvidencePanel, {
              key: 'source-run',
              title: '来源运行（对应原版本）',
              description: '这是来源流程的执行结果，只对应原版本，不表示当前草稿已执行。',
              graph: sourceForDraft?.graph ?? graph,
              run: sourceForDraft?.run,
              selectedNodeId,
              ...(sourceResume === undefined ? {} : {
                resume: sourceResume,
                onResume: resumeOriginalRun,
                resuming: resumingCommands.has(resumeKey(sourceResume.commandId, sourceResume.sourceId)),
                resumeDisabled: api === undefined,
              }),
            }),
          draftRun === undefined
            ? null
            : createElement(RunEvidencePanel, {
              key: 'draft-run',
              title: '此草稿的已保存版本',
              description: '此执行结果只对应当前精确保存版本；保存或修改后会重新按版本区分。',
              graph,
              run: draftRun.run,
              selectedNodeId,
            }),
        ]),
        createElement(NodeInspector, {
          key: 'node-inspector',
          graph,
          node: selectedNode,
          onChange: node => changeDraft(current => withStudioNode(current, node)),
          onDelete: node => {
            changeDraft(current => withoutStudioNodes(current, new Set([node.id])))
            setSelectedNodeId(undefined)
          },
        }),
                ]),
              ],
    runRecords.length === 0
      ? null
      : createElement(RunList, {
        key: 'runs',
        records: runRecords,
        onInspect: commandId => { void inspectRun(commandId) },
        onResume: commandId => { void resumeOriginalRun(commandId) },
        busyCommands,
        resumingCommands,
        resumeDisabled: api === undefined,
      }),
  ])
}

/** Hover text of the composer toggle; it states what the mode changes and that selecting it runs nothing. */
export const SESSION_MODE_TOGGLE_TITLE = '智能协同：开启后，主模型会把适合拆分的复杂任务交给 Codex 或 Claude Code 协同执行。切换本身不会调用模型。'

/**
 * The session's collaboration mode as one composer toggle. Pressed means
 * `smart`. A failed read or selection is shown in a popover above the toggle
 * until the next click; a successful selection shows nothing besides the
 * pressed state. It never starts an execution.
 */
export function SessionModeControl({ sessionId, api, error }: WorkflowStudioPanelProps): ReactElement {
  const [overview, setOverview] = useState<StudioOverview | undefined>()
  const [failure, setFailure] = useState<string | undefined>()
  const [pending, setPending] = useState(false)
  const activeSessionRef = useRef(sessionId)
  const requestRef = useRef(0)
  activeSessionRef.current = sessionId

  useEffect(() => {
    const requestedSessionId = sessionId
    const requestId = ++requestRef.current
    setOverview(undefined)
    setFailure(undefined)
    if (api === undefined) return
    void api.overview({ sessionId: requestedSessionId }).then(next => {
      if (requestId !== requestRef.current || !isCurrentStudioOverview(requestedSessionId, activeSessionRef.current, next)) return
      setOverview(next)
    }).catch(caught => {
      if (requestId === requestRef.current && activeSessionRef.current === requestedSessionId) {
        setFailure(`无法读取智能协同状态：${messageFor(caught, '请求未完成。')}`)
      }
    })
  }, [api, sessionId])

  const toggle = useCallback(async (): Promise<void> => {
    setFailure(undefined)
    if (api === undefined || overview === undefined || pending) return
    const mode = overview.mode.mode === 'smart' ? 'ordinary' : 'smart'
    const requestedSessionId = sessionId
    setPending(true)
    try {
      const next = await api.setMode({ sessionId: requestedSessionId, mode, expectedRevision: overview.mode.revision })
      if (activeSessionRef.current !== requestedSessionId || next.sessionId !== requestedSessionId) return
      setOverview(current => current === undefined ? current : { ...current, mode: next })
    } catch (caught) {
      if (activeSessionRef.current === requestedSessionId) {
        setFailure(`${mode === 'smart' ? '无法开启' : '无法关闭'}智能协同：${messageFor(caught, '请求未完成。')}`)
      }
    } finally {
      if (activeSessionRef.current === requestedSessionId) setPending(false)
    }
  }, [api, overview, pending, sessionId])

  const smart = overview?.mode.mode === 'smart'
  const message = visibleError(error, '智能协同服务暂不可用。') ?? failure
  return createElement('span', { className: 'solar-session-mode' }, [
    createElement(SessionModeStyles, { key: 'styles' }),
    createElement('button', {
      key: 'toggle',
      type: 'button',
      className: 'solar-session-mode__toggle',
      title: SESSION_MODE_TOGGLE_TITLE,
      disabled: api === undefined || pending || overview === undefined,
      'aria-pressed': smart,
      onClick: () => { void toggle() },
    }, [
      createElement('svg', { key: 'icon', viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }, [
        createElement('circle', { key: 'a', cx: 4, cy: 4, r: 2 }),
        createElement('circle', { key: 'b', cx: 12, cy: 4, r: 2 }),
        createElement('circle', { key: 'c', cx: 8, cy: 12, r: 2 }),
        createElement('path', { key: 'ab', d: 'M6 4h4M5 5.7l2 4.6M11 5.7l-2 4.6' }),
      ]),
      createElement('span', { key: 'label' }, '智能协同'),
    ]),
    message === undefined
      ? null
      : createElement('span', { key: 'failure', className: 'solar-session-mode__popover', role: 'alert' }, message),
  ])
}
