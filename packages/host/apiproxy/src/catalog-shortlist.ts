/** Account-visible menu shortcuts: flagship family and latest mainstream family. */
import type { ModelCatalogSnapshot, StoredCatalogModel } from '@deepseek-ai/dsh-model-catalog-local/types'

function family(source: string, model: StoredCatalogModel): number {
  const label = `${model.id} ${model.name}`.toLowerCase()
  if (source.startsWith('native:')) {
    if (/(?:^|[\s-])astra(?:$|[\s-])/u.test(label)) return 0
    if (/(?:^|[\s-])sol(?:$|[\s-])/u.test(label)) return 1
  } else if (source.startsWith('web:')) {
    if (/\bpro\b/u.test(label)) return 0
    if (/\bthinking\b/u.test(label)) return 1
  } else if (source.startsWith('deepseek:')) {
    if (/\bpro\b/u.test(label)) return 0
    if (/\bflash\b/u.test(label)) return 1
  }
  return 2
}

function generation(model: StoredCatalogModel): readonly number[] {
  const match = /(?:^|[\s-])v?(\d+(?:\.\d+)*)(?=[\s-]|$)/iu.exec(`${model.id} ${model.name}`)
  return match?.[1]?.split('.').map(Number) ?? []
}

function newer(left: StoredCatalogModel, right: StoredCatalogModel): number {
  const a = generation(left)
  const b = generation(right)
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (b[index] ?? 0) - (a[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * Select up to two available shortcuts without claiming a cross-provider benchmark.
 * Prefer the latest observed flagship and mainstream families; fill missing slots
 * from remaining upstream entries, newest generation first and stable on ties.
 * Explicit source ranks override family policy. Native proxy routes are excluded.
 * @param source - full persisted inventory for one active discovery source.
 * @returns available menu models, preserving their exact dispatch tokens.
 */
export function selectFeaturedModels(source: ModelCatalogSnapshot): StoredCatalogModel[] {
  if (!source.menuVisible || source.state !== 'ready') return []
  const available = source.models.filter(model => model.availability === 'available'
    && !(source.id.startsWith('native:') && model.id.includes('/')))
  const ranked = available.flatMap(model => model.featuredRank === undefined ? [] : [{ model, rank: model.featuredRank }])
  if (ranked.length > 0) return ranked.sort((a, b) => a.rank - b.rank).slice(0, 2).map(entry => entry.model)
  const ordered = [...available].sort(newer)
  const selected = [0, 1].flatMap((tier) => {
    const model = ordered.find(entry => family(source.id, entry) === tier)
    return model === undefined ? [] : [model]
  })
  for (const model of ordered) {
    if (selected.length === 2) break
    if (!selected.includes(model)) selected.push(model)
  }
  return selected
}
