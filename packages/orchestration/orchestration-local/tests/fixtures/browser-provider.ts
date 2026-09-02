import type { Context } from '@deepseek-ai/cordis'
import {
  BrowserProviderId,
  BrowserWorkspaceId,
  type BrowserOperationResultV1,
  type BrowserProvider,
  type BrowserRunPlanV1,
} from '@deepseek-ai/dsh-browser'

function operationResult(operation: BrowserRunPlanV1['operations'][number]): BrowserOperationResultV1 {
  switch (operation.kind) {
    case 'open':
    case 'select-page':
    case 'navigate':
    case 'reload':
    case 'page-info':
      return {
        kind: 'page', id: operation.id, operation: operation.kind,
        page: { page: operation.page, url: operation.kind === 'open' || operation.kind === 'navigate' ? operation.url : 'fixture://browser' },
      }
    case 'pages': return { kind: 'pages', id: operation.id, pages: [] }
    case 'snapshot': return { kind: 'snapshot', id: operation.id, content: 'fixture browser snapshot' }
    case 'read': return { kind: 'read', id: operation.id, value: 'fixture browser value' }
    case 'count': return { kind: 'count', id: operation.id, count: 1 }
    case 'wait':
    case 'click':
    case 'fill':
    case 'clear':
    case 'press':
    case 'check':
    case 'select':
    case 'close-page':
    case 'complete':
      return { kind: 'done', id: operation.id, operation: operation.kind }
  }
}

const provider: BrowserProvider = {
  descriptor: {
    id: BrowserProviderId('fixture-browser'),
    layers: ['portable-plan-v1'],
    capabilities: ['semantic-snapshot'],
  },
  available: () => true,
  runPlan: async plan => ({
    version: 1,
    workspace: { id: BrowserWorkspaceId('fixture-workspace'), lifecycle: 'active', control: 'agent' },
    operations: plan.operations.map(operationResult),
  }),
}

export const name = 'fixture-browser-provider'
export const inject = ['browser']

export function apply(ctx: Context): void {
  ctx.browser.registerProvider(provider)
}

export default { name, inject, apply }
