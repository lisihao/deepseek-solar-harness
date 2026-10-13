/**
 * Display names for a model selection, resolved from the directory's provider groups. A native model the Host reports
 * as `<operator>:<model>` is named by its operator entry and model name, so no internal id reaches the user.
 */
import type { ModelCatalogFailure, ModelProviderGroup, ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'

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
 * The display name of one native operator. A bare operator entry names itself; after a catalog refresh the operator
 * is only the source of its `<operator>:<model>` rows, whose `sourceName` carries it; before the first refresh it is a
 * failure row `<source>:<operator id>`.
 */
function operatorEntry(
  entries: readonly ModelProviderGroup['models'][number][],
  failures: readonly ModelCatalogFailure[],
  operatorId: string,
): { readonly name: string } | undefined {
  const bare = entries.find(model => model.id === operatorId)
  if (bare !== undefined) return bare
  const sourced = entries.find(model => model.id.startsWith(`${operatorId}:`) && model.sourceName !== undefined)
  if (sourced?.sourceName !== undefined) return { name: sourced.sourceName }
  return failures.find(failure => failure.id.slice(failure.id.indexOf(':') + 1) === operatorId)
}

/**
 * Describe a selection for display.
 * @param directory - the directory's provider groups and provider-local failures. Before its catalog is first
 *   refreshed a native operator is only a failure row (`<source>:<operator id>`, with the operator's display name), so
 *   that row names the operator too.
 * @param selection - the selection to name.
 * @returns the model and effort labels.
 */
export function describeSelection(
  directory: { readonly groups: readonly ModelProviderGroup[]; readonly failures: readonly ModelCatalogFailure[] },
  selection: ModelSelection,
): SelectionLabel {
  const entries = directory.groups.filter(group => group.id === selection.provider).flatMap(group => group.models)
  const listed = entries.find(model => model.id === selection.model)
  const colon = selection.model.indexOf(':')
  const operatorId = colon < 0 ? undefined : selection.model.slice(0, colon)
  const operator = operatorId === undefined ? undefined : operatorEntry(entries, directory.failures, operatorId)
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
