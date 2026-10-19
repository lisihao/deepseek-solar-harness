import { RPC_REMOTE } from './remote.js'
/** Explicit public Typert descriptors; method input boundaries validate in NativeControl. */
export const TYPERT = {
  package: RPC_REMOTE.package, face: 'host', schemas: [],
  model: { services: [{ tags: [], key: 'solarNativeControl', exportName: 'NativeControl', description: 'Owner-only native collaboration controls', summary: 'Native collaboration UI', jsDoc: 'Read status and explicitly control native acceptance tasks.', members: RPC_REMOTE.descriptors.map(value => ({ name: value.method, kind: 'method', signature: '(input?: unknown): Promise<unknown>' })), types: [] }], events: [], objects: [] },
  invocations: RPC_REMOTE.descriptors,
}
