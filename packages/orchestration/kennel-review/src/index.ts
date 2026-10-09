/** Kennel collaboration kinds in which members review another member's finished work, rework it, and check the rework. */
import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig } from './config.ts'
import { kennelRereviewKind } from './rereview.ts'
import { kennelReviewKind } from './review.ts'
import { kennelReworkKind } from './rework.ts'

export { KENNEL_REREVIEW_KIND, KENNEL_REVIEW_KIND, KENNEL_REWORK_KIND } from './kinds.ts'
export { kennelRereviewKind } from './rereview.ts'
export { kennelReviewKind } from './review.ts'
export { kennelReworkKind } from './rework.ts'
export { APPROVE_LINE, CHANGES_LINE, parseConclusion, reviewOutcome } from './verdict.ts'

export const name = 'kennel-review'
export const inject = ['kennelCollaborations', 'orchestrations']

export { Config, resolveConfig } from './config.ts'

/**
 * Register the review, rework, and rereview kinds for the lifetime of this plugin.
 * @param ctx - plugin context.
 * @param config - review bounds.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  ctx.effect(() => ctx.kennelCollaborations.register(kennelReviewKind(ctx, resolved)), 'kennel-review: review kind')
  ctx.effect(() => ctx.kennelCollaborations.register(kennelReworkKind(ctx, resolved)), 'kennel-review: rework kind')
  ctx.effect(() => ctx.kennelCollaborations.register(kennelRereviewKind(ctx)), 'kennel-review: rereview kind')
}
