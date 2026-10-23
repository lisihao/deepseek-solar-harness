import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'

const PKG = '@lisihao/dsh-solar-bench'

/** Lazy strict codecs: the UI only needs descriptor metadata, as in the rc.2 client contribution shape. */
const codec = (typeSymbol: string) => {
  const schema = { parse: (value: unknown): unknown => value }
  return {
    mode: 'strict' as const,
    typeSymbol: `${PKG}#${typeSymbol}`,
    schema,
    create: () => schema,
    decode: (value: unknown) => value,
    encode: (value: unknown) => value,
  }
}

/** Owner-only ledger read descriptors mounted by the client bundle. */
export const RPC_REMOTE: TypertRemoteContribution = {
  package: PKG,
  descriptors: [
    {
      id: `${PKG}#solarBenchLedgers/list`,
      service: 'solarBenchLedgers',
      namespace: 'solarBenchLedgers',
      method: 'list',
      invocation: { kind: 'direct' as const },
      parameters: [],
      result: codec('BenchExperimentList'),
    },
    {
      id: `${PKG}#solarBenchLedgers/detail`,
      service: 'solarBenchLedgers',
      namespace: 'solarBenchLedgers',
      method: 'detail',
      invocation: { kind: 'direct' as const },
      parameters: [{ name: 'input', wire: 'input', source: 'json' as const, codec: codec('BenchDetailInput') }],
      result: codec('BenchExperimentDetail'),
    },
  ],
}
