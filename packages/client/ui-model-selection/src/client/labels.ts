/**
 * Display names for a model selection, resolved from the directory's provider groups. A native model the Host reports
 * as `<operator>:<model>` is named by its operator entry and model name, so no internal id reaches the user.
 */
import type { ModelProviderGroup, ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'

/** A selection described for display. */
export interface SelectionLabel {
  /** The model's display name, or for a model the menu does not list its operator entry and native name. */
  readonly model: string
  /** The effort's display name, or its id when the model lists no such level. */
  readonly effort?: string
  /** Whether the directory names the model, directly or by its operator entry; otherwise `model` is only a raw id. */
  readonly named: boolean
}

/**
 * Describe a selection for display.
 * @param groups - the directory's provider groups.
 * @param selection - the selection to name.
 * @returns the model and effort labels.
 */
export function describeSelection(groups: readonly ModelProviderGroup[], selection: ModelSelection): SelectionLabel {
  const entries = groups.filter(group => group.id === selection.provider).flatMap(group => group.models)
  const listed = entries.find(model => model.id === selection.model)
  const colon = selection.model.indexOf(':')
  const operator = colon < 0 ? undefined : entries.find(model => model.id === selection.model.slice(0, colon))
  const nativeName = colon < 0 ? selection.model : selection.model.slice(colon + 1)
  const model = listed?.name ?? (operator === undefined ? nativeName : `${operator.name} · ${nativeName}`)
  const effort = selection.reasoningEffort === undefined
    ? undefined
    : listed?.reasoning?.efforts.find(level => level.id === selection.reasoningEffort)?.name ?? selection.reasoningEffort
  return { model, ...effort === undefined ? {} : { effort }, named: listed !== undefined || operator !== undefined }
}

/**
 * Join a model label and its effort the way the menu trigger does.
 * @param label - the described selection.
 * @returns `Model · Effort`, or the model alone.
 */
export function joinLabel(label: SelectionLabel): string {
  return label.effort === undefined ? label.model : `${label.model} · ${label.effort}`
}
