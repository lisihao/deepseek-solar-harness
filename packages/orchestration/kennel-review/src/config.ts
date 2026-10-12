/** Bounds of the review kind, loaded from cordis.yml. */
import z from '@deepseek-ai/schemastery'

/** Review plugin configuration. */
export interface Config {
  /** Most members that review one task. */
  readonly maxReviewers?: number
  /** Most recent finished tasks offered for review. */
  readonly maxTargets?: number
  /** Most times one task is handed back to its author, counting the rework of a rework. */
  readonly maxReworks?: number
}

export const Config: z<Config> = z.object({
  maxReviewers: z.number().step(1).min(1).max(4).default(2),
  maxTargets: z.number().step(1).min(1).max(20).default(5),
  maxReworks: z.number().step(1).min(1).max(5).default(2),
})

/**
 * Apply the schema defaults.
 * @param config - configuration as the Loader or a caller supplies it.
 * @returns every bound, set.
 */
export function resolveConfig(config: Config): Required<Config> {
  // The schema above gives every field a default, so the validated value always sets them.
  return Config(config) as Required<Config>
}
