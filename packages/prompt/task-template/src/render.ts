/**
 * Deterministic, non-executable task-template rendering and content hashing.
 *
 * @module @deepseek-ai/dsh-task-template/render
 */

import { createHash } from 'node:crypto'
import type {
  TaskAttributes,
  TaskTemplateRenderVariables,
  TaskTemplateSelectedContent,
  TaskTemplateVariableName,
} from './types.ts'

/** Supported placeholder names in stable documentation order. */
export const TASK_TEMPLATE_VARIABLES = [
  'objective', 'taskType', 'domain', 'outputFormat', 'language',
] as const satisfies readonly TaskTemplateVariableName[]

/** Stable rendering failure surfaced at authoring, disk, or selection time. */
export class TaskTemplateRenderError extends Error {
  /** Machine-readable error category. */
  readonly code = 'TASK_TEMPLATE_RENDER'

  /**
   * @param message - precise rejected syntax, variable, or value.
   */
  constructor(message: string) {
    super(message)
    this.name = 'TaskTemplateRenderError'
  }
}

type TemplateToken = string | { readonly variable: TaskTemplateVariableName }

/** Parse the reserved `{{name}}` syntax without evaluating expressions. */
function parseMethod(method: string, at: string): readonly TemplateToken[] {
  const tokens: TemplateToken[] = []
  let cursor = 0
  while (cursor < method.length) {
    const open = method.indexOf('{{', cursor)
    const strayClose = method.indexOf('}}', cursor)
    if (strayClose >= 0 && (open < 0 || strayClose < open)) {
      throw new TaskTemplateRenderError(`${at} has an unmatched "}}" at offset ${String(strayClose)}`)
    }
    if (open < 0) {
      tokens.push(method.slice(cursor))
      break
    }
    if (open > cursor) tokens.push(method.slice(cursor, open))
    const close = method.indexOf('}}', open + 2)
    if (close < 0) {
      throw new TaskTemplateRenderError(`${at} has an unclosed "{{" at offset ${String(open)}`)
    }
    const name = method.slice(open + 2, close)
    if (!(TASK_TEMPLATE_VARIABLES as readonly string[]).includes(name)) {
      throw new TaskTemplateRenderError(
        `${at} references unsupported variable "${name}"; supported: ${TASK_TEMPLATE_VARIABLES.join(', ')}`,
      )
    }
    tokens.push({ variable: name as TaskTemplateVariableName })
    cursor = close + 2
  }
  return tokens
}

/**
 * Validate a stored method's placeholder syntax without task values.
 * @param method - raw method content.
 * @param at - field label used in an error.
 */
export function validateTaskTemplateMethod(method: string, at = 'task-template method'): void {
  parseMethod(method, at)
}

/**
 * Select the exact renderable values from a task description.
 * @param attributes - complete task characteristics.
 * @returns a detached render-variable record.
 */
export function taskTemplateRenderVariables(attributes: TaskAttributes): TaskTemplateRenderVariables {
  return {
    objective: attributes.objective,
    taskType: attributes.taskType,
    domain: attributes.domain,
    outputFormat: attributes.outputFormat,
    language: attributes.language,
  }
}

/**
 * Render one method by substituting only the fixed variable vocabulary.
 * Inserted values are never rescanned, so they cannot introduce expressions.
 * @param method - validated or untrusted raw method content.
 * @param variables - exact task values used for substitution.
 * @returns rendered method text.
 */
export function renderTaskTemplateMethod(
  method: string,
  variables: TaskTemplateRenderVariables,
): string {
  return parseMethod(method, 'task-template method').map((token) => {
    if (typeof token === 'string') return token
    const value = variables[token.variable]
    if (value.trim().length === 0) {
      throw new TaskTemplateRenderError(`task-template variable "${token.variable}" has no value`)
    }
    return value
  }).join('')
}

/**
 * Hash exact rendered layers with an unambiguous array encoding.
 * @param content - exact content handed to a Consumer.
 * @returns lowercase hexadecimal SHA-256.
 */
export function taskTemplateContentSha256(content: TaskTemplateSelectedContent): string {
  const canonical = JSON.stringify([
    content.method,
    content.preferences ?? null,
    content.memory ?? null,
  ])
  return createHash('sha256').update(canonical).digest('hex')
}
