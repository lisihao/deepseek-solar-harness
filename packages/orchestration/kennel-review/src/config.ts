/** Bounds of the review kind, loaded from cordis.yml. */
import z from '@deepseek-ai/schemastery'

/** Review plugin configuration. */
export interface Config {
  /** Most members that review one task. */
  readonly maxReviewers?: number
  /** Most recent finished tasks offered for review. */
  readonly maxTargets?: number
}

export const Config: z<Config> = z.object({
  maxReviewers: z.number().step(1).min(1).max(4).default(2),
  maxTargets: z.number().step(1).min(1).max(20).default(5),
})

/**
 * Apply the schema defaults.
 * @param config - configuration as the Loader or a caller supplies it.
 * @returns both bounds, set.
 */
export function resolveConfig(config: Config): Required<Config> {
  // The schema above gives both fields a default, so the validated value always sets them.
  return Config(config) as Required<Config>
}
