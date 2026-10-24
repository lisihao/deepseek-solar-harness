import { RPC_REMOTE } from './remote.js'
export const TYPERT = {
  package: RPC_REMOTE.package, face: 'host', schemas: [],
  model: { services: [
    { key: 'solarBenchLedgers', exportName: 'BenchLedgersControl', summary: 'Benchmark experiments', jsDoc: 'List experiment ledgers and read one experiment with its analysis.' },
    { key: 'solarBenchRuns', exportName: 'BenchRunsControl', summary: 'Benchmark runs', jsDoc: 'Start, observe and stop one experiment at a time.' },
  ].map(service => ({ ...service, tags: [], description: 'Owner-only benchmark controls', members: RPC_REMOTE.descriptors.filter(value => value.service === service.key).map(value => ({ name: value.method, kind: 'method', signature: '(input?: unknown): Promise<unknown>' })), types: [] })), events: [], objects: [] },
  invocations: RPC_REMOTE.descriptors,
}
