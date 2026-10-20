import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'

const PKG = '@lisihao/dsh-solar-rlm'

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

/** Public Host Remote descriptors. The owner registers the implementation. */
export const RPC_REMOTE: TypertRemoteContribution = {
  package: PKG,
  descriptors: [
    {
      id: `${PKG}#solarRlmControl/status`,
      service: 'solarRlmControl',
      namespace: 'solarRlmControl',
      method: 'status',
      invocation: { kind: 'direct' as const },
      parameters: [],
      result: codec('RlmUiStatus'),
    },
    {
      id: `${PKG}#solarRlmControl/check`,
      service: 'solarRlmControl',
      namespace: 'solarRlmControl',
      method: 'check',
      invocation: { kind: 'direct' as const },
      parameters: [{ name: 'input', wire: 'input', source: 'json' as const, codec: codec('SelfTestInput') }],
      result: codec('SelfTestReport'),
    },
    {
      id: `${PKG}#solarRlmControl/inspect`,
      service: 'solarRlmControl',
      namespace: 'solarRlmControl',
      method: 'inspect',
      invocation: { kind: 'direct' as const },
      parameters: [{ name: 'input', wire: 'input', source: 'json' as const, codec: codec('InspectInput') }],
      result: codec('RunSummary'),
    },
    {
      id: `${PKG}#solarRlmControl/cancel`,
      service: 'solarRlmControl',
      namespace: 'solarRlmControl',
      method: 'cancel',
      invocation: { kind: 'direct' as const },
      parameters: [{ name: 'input', wire: 'input', source: 'json' as const, codec: codec('CancelInput') }],
      result: codec('RunSummary'),
    },
  ],
}

export { PKG as RLM_RPC_PACKAGE }
