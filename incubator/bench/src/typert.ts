import { RPC_REMOTE } from './remote.js'
export const TYPERT = {
  package: RPC_REMOTE.package, face: 'host', schemas: [],
  model: { services: [
    { key: 'solarBenchLedgers', exportName: 'BenchLedgersControl' },
  ].map(service => ({ ...service, tags: [], description: 'Owner-only benchmark ledger reads', summary: 'Benchmark experiments', jsDoc: 'List experiment ledgers and read one experiment with its analysis.', members: RPC_REMOTE.descriptors.filter(value => value.service === service.key).map(value => ({ name: value.method, kind: 'method', signature: '(input?: unknown): Promise<unknown>' })), types: [] })), events: [], objects: [] },
  invocations: RPC_REMOTE.descriptors,
}
