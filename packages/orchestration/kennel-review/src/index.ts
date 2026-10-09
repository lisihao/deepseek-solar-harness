/** Kennel collaboration kinds in which members review another member's finished work and rework it from the comments. */
import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig } from './config.ts'
import { kennelReviewKind } from './review.ts'
import { kennelReworkKind } from './rework.ts'

export { KENNEL_REVIEW_KIND, kennelReviewKind } from './review.ts'
export { KENNEL_REWORK_KIND, kennelReworkKind } from './rework.ts'
export { APPROVE_LINE, CHANGES_LINE, parseConclusion, reviewOutcome } from './verdict.ts'

export const name = 'kennel-review'
export const inject = ['kennelCollaborations', 'orchestrations']

export { Config, resolveConfig } from './config.ts'

/**
 * Register the review and rework kinds for the lifetime of this plugin.
 * @param ctx - plugin context.
 * @param config - review bounds.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  ctx.effect(() => ctx.kennelCollaborations.register(kennelReviewKind(ctx, resolved)), 'kennel-review: review kind')
  ctx.effect(() => ctx.kennelCollaborations.register(kennelReworkKind(ctx)), 'kennel-review: rework kind')
}
