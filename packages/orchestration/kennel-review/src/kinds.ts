/** Names of the kinds this package registers. */

/** A first review of a finished task. */
export const KENNEL_REVIEW_KIND = 'review'
/** The same reviewers checking a task that was reworked from their comments. */
export const KENNEL_REREVIEW_KIND = 'rereview'
/** The author taking a task again from the comments of a review that asked for changes. */
export const KENNEL_REWORK_KIND = 'rework'

/**
 * Whether a collaboration is a review of some task, first or repeated.
 * @param collaboration - registered kind name.
 * @returns true for `review` and `rereview`.
 */
export function isReview(collaboration: string): boolean {
  return collaboration === KENNEL_REVIEW_KIND || collaboration === KENNEL_REREVIEW_KIND
}
