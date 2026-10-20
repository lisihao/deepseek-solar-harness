import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'

const PKG = '@lisihao/dsh-solar-chatgpt-web'

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

/** Owner-only preferences descriptors mounted by the client bundle. */
export const RPC_WEB_PREFERENCES: TypertRemoteContribution = {
  package: PKG,
  descriptors: [
    {
      id: `${PKG}#solarWebPreferences/read`,
      service: 'solarWebPreferences',
      namespace: 'solarWebPreferences',
      method: 'read',
      invocation: { kind: 'direct' as const },
      parameters: [],
      result: codec('WebPreferences'),
    },
    {
      id: `${PKG}#solarWebPreferences/save`,
      service: 'solarWebPreferences',
      namespace: 'solarWebPreferences',
      method: 'save',
      invocation: { kind: 'direct' as const },
      parameters: [{ name: 'input', wire: 'input', source: 'json' as const, codec: codec('WebPreferencesSaveInput') }],
      result: codec('WebPreferences'),
    },
  ],
}
