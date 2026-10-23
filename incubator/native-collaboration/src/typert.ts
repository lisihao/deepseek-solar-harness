import { RPC_REMOTE } from './remote.js'
export const TYPERT = {
  package: RPC_REMOTE.package, face: 'host', schemas: [],
  model: { services: [
    { key: 'solarNativeControl', exportName: 'NativeControl' },
    { key: 'solarWorkflowControl', exportName: 'StudioControl' },
  ].map(service => ({ ...service, tags: [], description: 'Owner-only conversation workflow controls', summary: 'Conversation execution flow', jsDoc: 'Edit drafts and explicitly execute or observe the original workflow.', members: RPC_REMOTE.descriptors.filter(value => value.service === service.key).map(value => ({ name: value.method, kind: 'method', signature: '(input?: unknown): Promise<unknown>' })), types: [] })), events: [], objects: [] },
  invocations: RPC_REMOTE.descriptors,
}
