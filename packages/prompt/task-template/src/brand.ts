/**
 * Runtime factory for the {@link TaskTemplateId} brand owned by this package.
 * 本包拥有的 {@link TaskTemplateId} 品牌类型的运行时工厂。
 * @module @deepseek-ai/dsh-task-template/brand
 */

import type { TaskTemplateId } from './types.ts'

/** Allowed template-id form: lowercase kebab-case starting with a letter. 模板 ID 形式。 */
export const TASK_TEMPLATE_ID_PATTERN = /^[a-z][a-z0-9-]*$/

/**
 * Brand a raw string as a {@link TaskTemplateId}.
 * 将原始字符串标记为 {@link TaskTemplateId}。
 * @param value - candidate id; lowercase kebab-case, as in `code-review-basic`.
 * @returns the branded template id.
 */
export function taskTemplateId(value: string): TaskTemplateId {
  if (!TASK_TEMPLATE_ID_PATTERN.test(value)) {
    throw new TypeError(`task template id "${value}" must match ${String(TASK_TEMPLATE_ID_PATTERN)}`)
  }
  return value as TaskTemplateId
}
