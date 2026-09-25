/** Runtime invariants for the physical-operator registry and lifecycle. @module @deepseek-ai/dsh-physical-operator/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type {
  PhysicalOperator,
  PhysicalOperatorExecutionEndInfo,
  PhysicalOperatorExecutionInfo,
  PhysicalOperatorId,
} from './index.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-physical-operator'

/** Cordis companion plugin name. */
export const name = 'physical-operator-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Install registry and start/end identity checks. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const operators = new Set(ctx.physicalOperators.list().map(entry => String(entry.id)))
  const executions = new Map<string, PhysicalOperatorExecutionInfo>()
  const stagedAdded = new WeakSet<PhysicalOperator>()
  const stagedRemoved = new Set<string>()
  const stagedStart = new WeakSet<PhysicalOperatorExecutionInfo>()
  const stagedEnd = new WeakSet<PhysicalOperatorExecutionEndInfo>()

  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName === 'physical-operator/added') {
      const operator = args[0] as PhysicalOperator
      const id = String(operator.descriptor.id)
      if (operators.has(id)) fail(`physical-operator/added repeated ${JSON.stringify(id)}`)
      stagedAdded.add(operator)
      return
    }
    if (eventName === 'physical-operator/removed') {
      const id = String(args[0] as PhysicalOperatorId)
      if (!operators.has(id)) fail(`physical-operator/removed names unknown operator ${JSON.stringify(id)}`)
      stagedRemoved.add(id)
      return
    }
    if (eventName === 'physical-operator/start') {
      const info = args[0] as PhysicalOperatorExecutionInfo
      if (String(info.executionId).length === 0 || String(info.operatorId).length === 0) {
        fail('physical-operator/start executionId and operatorId must be non-empty')
      }
      if (executions.has(info.executionId)) {
        fail(`physical-operator/start repeated execution id ${JSON.stringify(info.executionId)}`)
      }
      stagedStart.add(info)
      return
    }
    if (eventName !== 'physical-operator/end') return
    const info = args[0] as PhysicalOperatorExecutionEndInfo
    const start = executions.get(info.executionId)
    if (start === undefined) {
      fail(`physical-operator/end has no matching start for ${JSON.stringify(info.executionId)}`)
    }
    if (start.operatorId !== info.operatorId) {
      fail(`physical-operator/end operator diverges for ${JSON.stringify(info.executionId)}`)
    }
    stagedEnd.add(info)
  }, { global: true })

  ctx.on('physical-operator/added', (operator) => {
    if (!stagedAdded.delete(operator)) return
    operators.add(String(operator.descriptor.id))
  }, { global: true })
  ctx.on('physical-operator/removed', (id) => {
    if (!stagedRemoved.delete(String(id))) return
    operators.delete(String(id))
  }, { global: true })
  ctx.on('physical-operator/start', (info) => {
    if (!stagedStart.delete(info)) return
    executions.set(info.executionId, info)
  }, { global: true })
  ctx.on('physical-operator/end', (info) => {
    if (!stagedEnd.delete(info)) return
    executions.delete(info.executionId)
  }, { global: true })
}, { inject: ['physicalOperators'] })

/** Register the package-owned invariant contribution. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
