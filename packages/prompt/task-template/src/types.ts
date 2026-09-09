/**
 * Type surface of the task-level prompt-template seam: the template id brand,
 * the task-attribute vocabulary, template records with their versioned method
 * layer and separate personalization layer, the typed selection interface for
 * later Consumers, and the seam's Cordis event declarations. Types only — no
 * runtime code.
 *
 * 任务级提示词模板接缝的类型面：模板 ID 品牌类型、任务属性词汇表、带版本化
 * 方法层与独立个性化层的模板记录、供后续 Consumer 使用的类型化选择接口，
 * 以及本接缝的 Cordis 事件声明。仅类型，无运行时代码。
 *
 * @module @deepseek-ai/dsh-task-template/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Nominal id of one user-managed task prompt template. 一个用户模板的品牌化 ID。 */
export type TaskTemplateId = Branded<'TaskTemplateId'>

/** Risk level of the task a template is selected for. 任务风险等级。 */
export type TaskRiskLevel = 'low' | 'medium' | 'high' | 'critical'

/** Priority of the task a template is selected for. 任务优先级。 */
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent'

/**
 * Attributes describing one concrete task at selection time. Every field is
 * required: the caller states what it knows, and a template constrains only
 * the dimensions it cares about.
 *
 * 选择时刻描述一个具体任务的属性。所有字段必填：调用方陈述任务事实，
 * 模板只约束它关心的维度。
 */
export interface TaskAttributes {
  /** Task category, such as `code-review` or `research`. 任务类型。 */
  taskType: string
  /** Subject domain, such as `frontend` or `finance`. 领域。 */
  domain: string
  /** Free-text objective of the task. 任务目标（自由文本）。 */
  objective: string
  /** Requested output format, such as `markdown-report`. 输出格式。 */
  outputFormat: string
  /** Risk level of executing the task. 风险等级。 */
  riskLevel: TaskRiskLevel
  /** Tool names available to the task. 可用工具。 */
  tools: readonly string[]
  /** Skill names loaded for the task. 已装载技能。 */
  skills: readonly string[]
  /** Physical operator names the task may run on. 适用算子。 */
  operators: readonly string[]
  /** Working language tag, such as `en` or `zh`. 语言。 */
  language: string
  /** Task priority. 优先级。 */
  priority: TaskPriority
}

/** Variables that a task-template method may reference. 模板方法可引用的变量。 */
export type TaskTemplateVariableName = 'objective' | 'taskType' | 'domain' | 'outputFormat' | 'language'

/** Exact task values used to render one selected method. 一次模板渲染使用的任务值。 */
export type TaskTemplateRenderVariables = Readonly<Record<TaskTemplateVariableName, string>>

/**
 * Declarative match criteria of one template. An absent field is a wildcard;
 * a present field must be a non-empty list. Per-dimension semantics:
 * value-list fields (`taskTypes`, `domains`, `outputFormats`, `riskLevels`,
 * `languages`, `priorities`) match when they contain the task's value;
 * `objectiveKeywords` match when every keyword occurs case-insensitively in
 * the objective; `requiredTools`/`requiredSkills` match when every listed name
 * is available to the task; `operators` match when the template shares at
 * least one operator with the task.
 *
 * 模板的声明式匹配条件。缺省字段为通配；出现的字段必须是非空列表。
 * 各维度语义：取值列表字段需包含任务值；`objectiveKeywords` 需全部（忽略
 * 大小写）出现在目标文本中；`requiredTools`/`requiredSkills` 需全部可用；
 * `operators` 需与任务算子至少有一个交集。
 */
export interface TaskTemplateMatch {
  /** Task types the template applies to. 适用任务类型。 */
  taskTypes?: readonly string[]
  /** Domains the template applies to. 适用领域。 */
  domains?: readonly string[]
  /** Keywords that must all occur in the task objective. 目标关键词（全部命中）。 */
  objectiveKeywords?: readonly string[]
  /** Output formats the template applies to. 适用输出格式。 */
  outputFormats?: readonly string[]
  /** Risk levels the template applies to. 适用风险等级。 */
  riskLevels?: readonly TaskRiskLevel[]
  /** Tools that must all be available to the task. 必需工具（全部可用）。 */
  requiredTools?: readonly string[]
  /** Skills that must all be loaded for the task. 必需技能（全部装载）。 */
  requiredSkills?: readonly string[]
  /** Operators the template is written for (one shared suffices). 适用算子（交集非空）。 */
  operators?: readonly string[]
  /** Languages the template applies to. 适用语言。 */
  languages?: readonly string[]
  /** Task priorities the template applies to. 适用优先级。 */
  priorities?: readonly TaskPriority[]
}

/**
 * One superseded revision of a template's reusable method layer. History
 * entries are immutable snapshots ordered by ascending version.
 *
 * 模板可复用方法层的一个历史版本，按版本号升序排列的不可变快照。
 */
export interface TaskTemplateRevision {
  /** Positive integer version this revision carried. 该修订的版本号。 */
  version: number
  /** Display name at this revision. 该修订时的名称。 */
  name: string
  /** Deterministic tie-break rank at this revision. 该修订时的排序权重。 */
  rank: number
  /** Match criteria at this revision. 该修订时的匹配条件。 */
  match: TaskTemplateMatch
  /** Reusable method prompt content at this revision. 该修订的方法内容。 */
  method: string
  /** Canonical ISO-8601 UTC instant this revision was committed. 该修订的规范 UTC ISO-8601 提交时间。 */
  updatedAt: string
}

/**
 * One user-managed task prompt template. The reusable method layer (`name`,
 * `rank`, `match`, `method`) is versioned: every edit bumps `version` and
 * archives the previous revision into `history`. Enablement is activation
 * state, not content, and never bumps the version. Personal
 * preference/memory content lives outside this record — see
 * {@link TaskTemplatePersonalization}.
 *
 * 一个用户管理的任务提示词模板。可复用方法层（名称、权重、匹配条件、方法
 * 内容）受版本化管理：每次编辑递增 `version` 并把旧修订归档进 `history`。
 * 启停是激活状态而非内容，不递增版本。个人偏好/记忆内容独立于本记录存放。
 */
export interface TaskTemplate {
  /** Unique template id. 模板唯一 ID。 */
  id: TaskTemplateId
  /** Whether the template participates in selection. 是否参与选择。 */
  enabled: boolean
  /** Canonical ISO-8601 UTC instant the template was created. 规范 UTC ISO-8601 创建时间。 */
  createdAt: string
  /** Current method-layer version, starting at 1. 当前版本号，从 1 开始。 */
  version: number
  /** Display name. 名称。 */
  name: string
  /** Deterministic tie-break rank; higher sorts first at equal specificity. 排序权重。 */
  rank: number
  /** Current match criteria. 当前匹配条件。 */
  match: TaskTemplateMatch
  /** Current reusable method prompt content. 当前方法内容。 */
  method: string
  /** Canonical ISO-8601 UTC instant of the last method-layer edit. 最近方法层编辑的规范 UTC ISO-8601 时间。 */
  updatedAt: string
  /** Superseded revisions, ascending by version. 历史修订，按版本升序。 */
  history: readonly TaskTemplateRevision[]
}

/**
 * Personal layer of one template: preference and memory content kept separate
 * from the reusable, versioned method layer. Editing this layer never bumps
 * the template version.
 *
 * 模板的个人层：与可复用、受版本化的方法层分离的偏好与记忆内容。
 * 编辑本层不递增模板版本。
 */
export interface TaskTemplatePersonalization {
  /** Personal preference content appended after the method. 个人偏好内容。 */
  preferences?: string
  /** Personal memory content appended after preferences. 个人记忆内容。 */
  memory?: string
}

/** Input for creating one template. 创建模板的输入。 */
export interface TaskTemplateDraft {
  /** Unique id, minted via `taskTemplateId`. 唯一 ID。 */
  id: TaskTemplateId
  /** Display name; must be non-blank. 名称，不得为空白。 */
  name: string
  /** Match criteria; omitted means match-all. 匹配条件，缺省为全匹配。 */
  match?: TaskTemplateMatch
  /** Reusable method prompt content; must be non-blank. 方法内容，不得为空白。 */
  method: string
  /** Tie-break rank; defaults to 0. 排序权重，默认 0。 */
  rank?: number
}

/** Method-layer patch for editing one template; absent fields keep their value. 编辑模板的补丁。 */
export interface TaskTemplatePatch {
  /** Next display name. 新名称。 */
  name?: string
  /** Next match criteria, replaced wholesale. 新匹配条件（整体替换）。 */
  match?: TaskTemplateMatch
  /** Next method content. 新方法内容。 */
  method?: string
  /** Next tie-break rank. 新排序权重。 */
  rank?: number
}

/** Selection input: the task's attributes plus an optional explicit override. 选择输入。 */
export interface TaskTemplateSelectionRequest {
  /** Attributes of the task needing a template. 任务属性。 */
  attributes: TaskAttributes
  /**
   * Explicitly requested template. When present it wins over automatic
   * ranking; naming an unknown or disabled template fails loud.
   * 显式指定的模板；存在时覆盖自动排序，指向未知或停用模板则报错。
   */
  explicitTemplateId?: TaskTemplateId
}

/** One template that survived deterministic filtering, with its ranking facts. 候选模板。 */
export interface TaskTemplateCandidate {
  /** Candidate template id. 候选模板 ID。 */
  id: TaskTemplateId
  /** Candidate's current version. 候选当前版本。 */
  version: number
  /** Candidate display name. 候选名称。 */
  name: string
  /** Count of match dimensions the template constrains (all matched). 命中约束维度数。 */
  specificity: number
  /** Template tie-break rank. 排序权重。 */
  rank: number
}

/** How the selected template was chosen. 选择来源。 */
export type TaskTemplateOverrideSource = 'explicit' | 'automatic' | 'none'

/** Which content layers an injection carries. 注入包含的内容层。 */
export interface TaskTemplateInjectionLayers {
  /** The reusable method layer is always injected with a selection. 方法层恒为注入。 */
  method: true
  /** Whether personal preference content was included. 是否包含个人偏好层。 */
  preferences: boolean
  /** Whether personal memory content was included. 是否包含个人记忆层。 */
  memory: boolean
}

/**
 * Serializable record of one selection outcome, suitable for logging. Plain
 * JSON data only: it survives `JSON.stringify`/`JSON.parse` unchanged.
 *
 * 一次选择结果的可序列化回执，适合写入日志。纯 JSON 数据，经
 * `JSON.stringify`/`JSON.parse` 往返不变。
 */
export interface TaskTemplateInjectionReceipt {
  /** Receipt format version. 回执格式版本。 */
  receiptVersion: 1
  /** Whether a template is injected for this task. 是否注入。 */
  decision: 'inject' | 'skip'
  /** How the injected template was chosen. 选择来源。 */
  overrideSource: TaskTemplateOverrideSource
  /** Injected template id; absent on skip. 注入模板 ID。 */
  templateId?: TaskTemplateId
  /** Injected template version; absent on skip. 注入模板版本。 */
  templateVersion?: number
  /** Content layers carried by the injection; absent on skip. 注入内容层。 */
  layers?: TaskTemplateInjectionLayers
  /** SHA-256 of the exact rendered content layers; absent on skip. 精确渲染内容的 SHA-256。 */
  contentSha256?: string
  /** Exact rendered layers handed to the Consumer; absent on skip. 交给 Consumer 的精确渲染层。 */
  renderedContent?: TaskTemplateSelectedContent
  /** Values substituted into the selected method; absent on skip. 方法占位符使用的值。 */
  renderVariables?: TaskTemplateRenderVariables
  /** Every candidate in final deterministic order. 最终确定性顺序的候选列表。 */
  candidates: readonly TaskTemplateCandidate[]
  /** Human-readable selection rationale. 选择理由。 */
  rationale: readonly string[]
  /** Echo of the task attributes the selection judged. 参与判定的任务属性回显。 */
  attributes: TaskAttributes
}

/** Content layers of the selected template, method plus personal overlays. 选中模板的内容层。 */
export interface TaskTemplateSelectedContent {
  /** Rendered reusable method prompt content. 已渲染的方法层内容。 */
  method: string
  /** Personal preference content, when stored. 偏好层内容。 */
  preferences?: string
  /** Personal memory content, when stored. 记忆层内容。 */
  memory?: string
}

/** The selected template as handed to a Consumer. 交给 Consumer 的选中模板。 */
export interface TaskTemplateSelected {
  /** Selected template id. 选中模板 ID。 */
  id: TaskTemplateId
  /** Selected template version. 选中模板版本。 */
  version: number
  /** Selected template display name. 选中模板名称。 */
  name: string
  /** Layered content to inject. 分层注入内容。 */
  content: TaskTemplateSelectedContent
  /** SHA-256 of {@link content}. 分层内容的 SHA-256。 */
  contentSha256: string
  /** Values substituted while rendering the method layer. 方法层渲染时替换的值。 */
  renderVariables: TaskTemplateRenderVariables
}

/**
 * Complete deterministic selection outcome. `decision: 'skip'` means no
 * template matched and nothing must be injected.
 *
 * 完整的确定性选择结果。`decision: 'skip'` 表示无匹配、不得注入。
 */
export interface TaskTemplateSelection {
  /** Whether a template is injected for this task. 是否注入。 */
  decision: 'inject' | 'skip'
  /** How the injected template was chosen. 选择来源。 */
  overrideSource: TaskTemplateOverrideSource
  /** The template to inject; absent on skip. 待注入模板。 */
  selected?: TaskTemplateSelected
  /** Every candidate in final deterministic order. 候选列表。 */
  candidates: readonly TaskTemplateCandidate[]
  /** Human-readable selection rationale. 选择理由。 */
  rationale: readonly string[]
  /** Loggable receipt of this outcome. 可记录回执。 */
  receipt: TaskTemplateInjectionReceipt
}

/** Kind of one committed template-store change. 一次模板库变更的类别。 */
export type TaskTemplateChangeKind = 'create' | 'update' | 'enable' | 'disable' | 'delete' | 'personalize'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Committed change to the template store, emitted after the provider
     * persisted it. A listener throw propagates to the mutation caller.
     * @param id - the template the change applies to.
     * @param kind - what changed; `delete` means the template no longer exists.
     * @param version - the template's method-layer version after the change
     * (for `delete`, the version the removed template last carried).
     * @mode emit
     */
    'task-template/updated'(id: TaskTemplateId, kind: TaskTemplateChangeKind, version: number): void
  }
}
