import { RPC_REMOTE } from './remote.js'

/** Explicit public Typert host metadata for the ChatGPT Web control service. */
export const TYPERT = {
  package: RPC_REMOTE.package,
  face: 'host',
  schemas: [],
  model: {
    services: [{
      tags: [],
      key: 'solarChatGptWebControl',
      exportName: 'WebControl',
      description: 'Owner-only ChatGPT webpage task controls',
      summary: 'ChatGPT 网页算子控制',
      jsDoc: 'Read webpage task state and explicitly launch, observe, or cancel a task.',
      members: RPC_REMOTE.descriptors.map(value => ({
        name: value.method,
        kind: 'method',
        signature: value.method === 'status'
          ? '(): Promise<unknown>'
          : '(input: unknown): Promise<unknown>',
      })),
      types: [],
    }],
    events: [],
    objects: [],
  },
  invocations: RPC_REMOTE.descriptors,
} as const
