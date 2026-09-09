/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-task-template`.
 * @module @deepseek-ai/dsh-task-template/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
// Type-only: resolves ctx.taskTemplates and the seam's event declarations.
import type {} from './service.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-task-template'

/** Cordis companion plugin name. */
export const name = 'task-template-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Install the commit-event contract: `task-template/updated` fires only from
 * a live service, a `delete` leaves the template absent, and every other kind
 * leaves the template present at exactly the emitted version.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  ctx.on('task-template/updated', (id, kind, version) => {
    const service = ctx.get('taskTemplates')
    if (service === undefined) {
      fail(`task-template/updated for "${id}" emitted without a live taskTemplates service`)
    }
    const template = service.get(id)
    if (kind === 'delete') {
      if (template !== undefined) {
        fail(`task-template/updated delete for "${id}" emitted while the template still exists`)
      }
      return
    }
    if (template === undefined) {
      fail(`task-template/updated ${kind} for "${id}" emitted while the template is absent`)
    }
    if (template.version !== version) {
      fail(`task-template/updated ${kind} for "${id}" carries version ${String(version)}; the template stands at ${String(template.version)}`)
    }
  })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
