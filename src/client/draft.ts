/**
 * Pure draft logic for the Luna Vision Bridge settings section. The browser
 * edits a plain draft and submits one `settings.update` patch naming only the
 * fields this section owns (`providerName`, `targets`); the Host re-validates
 * everything through `resolveConfig` before persisting.
 */

/** One editable downstream target row. */
export interface TargetDraft {
  provider: string
  model: string
  name: string
  bridgeModel: string
}

/** Patch form of a target row: blank optional fields are omitted entirely. */
export interface TargetPatch {
  provider: string
  model: string
  name?: string
  bridgeModel?: string
}

/**
 * The zero-configuration target the Host synthesizes when the user layer
 * carries no `targets`. The editor prefills one row with it so the effective
 * default stays visible instead of vanishing from the form.
 */
export const DEFAULT_TARGET: Pick<TargetDraft, 'provider' | 'model'> = {
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
}

/** Editable section draft (user-layer view). */
export interface LunaDraft {
  providerName: string
  targets: TargetDraft[]
}

function targetFromUnknown(value: unknown): TargetDraft | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as { provider?: unknown; model?: unknown; name?: unknown; bridgeModel?: unknown }
  if (typeof row.provider !== 'string' || typeof row.model !== 'string') return undefined
  return {
    provider: row.provider,
    model: row.model,
    name: typeof row.name === 'string' ? row.name : '',
    bridgeModel: typeof row.bridgeModel === 'string' ? row.bridgeModel : '',
  }
}

/**
 * Derive the initial draft from the resolved settings value (defaults
 * included). A section with no stored `targets` resolves to the legacy
 * single-target synthesis on the Host; the editor prefills that default row
 * so what is actually served is visible.
 */
export function draftFromValue(value: unknown): LunaDraft {
  const section = typeof value === 'object' && value !== null
    ? value as { providerName?: unknown; targets?: unknown }
    : {}
  const stored = Array.isArray(section.targets)
    ? section.targets.map(targetFromUnknown).filter((row): row is TargetDraft => row !== undefined)
    : []
  const targets = stored.length > 0
    ? stored
    : [{ ...blankTarget(), ...DEFAULT_TARGET }]
  return {
    providerName: typeof section.providerName === 'string' ? section.providerName : '',
    targets,
  }
}

/** The bridge model id the Host would resolve for one row (`bridgeModel` or `<provider>-<model>`). */
function effectiveBridgeModel(row: TargetDraft): string {
  return row.bridgeModel.trim() !== '' ? row.bridgeModel.trim() : `${row.provider.trim()}-${row.model.trim()}`
}

/** Whether the draft can be submitted as-is. */
export function draftBlockers(draft: LunaDraft): string[] {
  const blockers: string[] = []
  if (draft.providerName.trim() === '') {
    blockers.push('Provider 显示名不能为空（可用"恢复默认"还原）')
  }
  const seen = new Set<string>()
  draft.targets.forEach((row, index) => {
    if (row.provider.trim() === '') blockers.push(`第 ${index + 1} 行缺少 provider`)
    if (row.model.trim() === '') blockers.push(`第 ${index + 1} 行缺少 model`)
    // Defaulted ids collide exactly like explicit ones do on the Host; rows
    // missing provider/model are already blocked and their derived id is junk.
    if (row.provider.trim() !== '' && row.model.trim() !== '') {
      const id = effectiveBridgeModel(row)
      if (seen.has(id)) blockers.push(`桥接模型 id "${id}" 重复（含自动生成）`)
      seen.add(id)
    }
  })
  return blockers
}

/**
 * The `settings.update` patch for one draft. `providerName` is always present
 * (blank drafts are refused by `draftBlockers`; clearing an existing override
 * is the "恢复默认" button's `unset` job, because `update` merges and can
 * never remove a stored field). `targets` is always named so an empty list
 * explicitly falls back to the legacy single-target synthesis on the Host.
 */
export function draftToPatch(draft: LunaDraft): { providerName: string; targets: TargetPatch[] } {
  const targets: TargetPatch[] = draft.targets.map((row) => {
    const target: TargetPatch = { provider: row.provider.trim(), model: row.model.trim() }
    if (row.name.trim() !== '') target.name = row.name.trim()
    if (row.bridgeModel.trim() !== '') target.bridgeModel = row.bridgeModel.trim()
    return target
  })
  return { providerName: draft.providerName.trim(), targets }
}

/** One new empty row for the add button. */
export function blankTarget(): TargetDraft {
  return { provider: '', model: '', name: '', bridgeModel: '' }
}
