import { STUDIO_RPC_REMOTE } from './studio-remote.js'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
const PKG = '@lisihao/dsh-solar-native-collaboration'
const codec = (typeSymbol: string) => {
  const schema = { parse: (value: unknown): unknown => value }
  return { mode: 'strict' as const, typeSymbol: `${PKG}#${typeSymbol}`, schema, create: () => schema, decode: (v: unknown) => v, encode: (v: unknown) => v }
}
export const RPC_REMOTE: TypertRemoteContribution = {
  package: PKG,
  descriptors: [...['status', 'inspect', 'control', 'test'].map(method => ({
    id: `${PKG}#solarNativeControl/${method}`, service: 'solarNativeControl', namespace: 'solarNativeControl', method,
    invocation: { kind: 'direct' as const },
    parameters: method === 'status' ? [] : [{ name: 'input', wire: 'input', source: 'json' as const, codec: codec('Input') }],
    result: codec('Result'),
  })), ...STUDIO_RPC_REMOTE.descriptors],
}
