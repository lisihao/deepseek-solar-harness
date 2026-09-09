/**
 * Task-level prompt-template capability seam (`ctx.taskTemplates`): the
 * Service Definition with its user-template lifecycle and typed deterministic
 * selection interface, the pure selection functions, the persisted store
 * format with its trust-boundary validation, and the file-backed provider
 * whose storage lives under explicit configuration or the DSH private-data
 * root. No Consumer is wired here; later Consumers inject `taskTemplates`
 * and call `select`.
 *
 * 任务级提示词模板能力接缝（`ctx.taskTemplates`）：带用户模板生命周期与
 * 类型化确定性选择接口的 Service Definition、纯选择函数、带信任边界校验的
 * 持久化存储格式，以及存储位于显式配置或 DSH 私有数据根之下的文件后端
 * Provider。此处不接线任何 Consumer；后续 Consumer 注入 `taskTemplates`
 * 并调用 `select`。
 *
 * @module @deepseek-ai/dsh-task-template
 */

export { TASK_TEMPLATE_ID_PATTERN, taskTemplateId } from './brand.ts'
export type * from './types.ts'
export { compareCandidates, matchSpecificity, matchesTask, selectTaskTemplate } from './selection.ts'
export {
  TASK_TEMPLATE_VARIABLES,
  TaskTemplateRenderError,
  renderTaskTemplateMethod,
  taskTemplateContentSha256,
  taskTemplateRenderVariables,
  validateTaskTemplateMethod,
} from './render.ts'
export {
  TASK_TEMPLATE_STORE_FORMAT_VERSION,
  TaskTemplateStoreError,
  emptyStoreDocument,
  parseStoreDocument,
  renderStoreDocument,
  validateMethod,
} from './store.ts'
export type { TaskTemplateStoreDocument } from './store.ts'
export { TaskTemplateService } from './service.ts'
export { FileTaskTemplateProvider, resolveStorePath } from './local.ts'
export type { Config } from './local.ts'

export { default } from './local.ts'
