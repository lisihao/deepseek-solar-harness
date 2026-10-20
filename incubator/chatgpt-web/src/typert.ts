import { RPC_REMOTE } from './remote.js'
export const TYPERT = {
  package: RPC_REMOTE.package, face: 'host', schemas: [],
  model: { services: [
    { key: 'solarChatGptWebControl', exportName: 'WebControl' },
    { key: 'solarWebPreferences', exportName: 'PreferencesControl' },
    { key: 'solarWebModelCatalog', exportName: 'ModelCatalogControl' },
  ].map(service => ({ ...service, tags: [], description: 'Owner-only Web conversation controls', summary: 'Web and Insight settings', jsDoc: 'Configure future requests and observe existing Web executions.', members: RPC_REMOTE.descriptors.filter(value => value.service === service.key).map(value => ({ name: value.method, kind: 'method', signature: '(input?: unknown): Promise<unknown>' })), types: [] })), events: [], objects: [] },
  invocations: RPC_REMOTE.descriptors,
}
