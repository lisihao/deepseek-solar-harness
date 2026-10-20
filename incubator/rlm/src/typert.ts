import { RPC_REMOTE } from './remote.js'

/** Explicit public Typert surface for the owner-only RLM controls. */
export const TYPERT = {
  package: RPC_REMOTE.package,
  face: 'host',
  schemas: [],
  model: {
    services: [{
      tags: [],
      key: 'solarRlmControl',
      exportName: 'SolarRlmControl',
      description: 'Owner-only Prime RLM runtime controls',
      summary: 'Prime RLM runtime status and keyless self-test',
      jsDoc: 'Read RLM runtime status and explicitly run a local self-test without a real provider request.',
      members: RPC_REMOTE.descriptors.map(value => ({
        name: value.method,
        kind: 'method',
        signature: value.method === 'status'
          ? '(): Promise<RlmUiStatus>'
          : '(input: unknown): Promise<unknown>',
      })),
      types: [],
    }],
    events: [],
    objects: [],
  },
  invocations: RPC_REMOTE.descriptors,
}
