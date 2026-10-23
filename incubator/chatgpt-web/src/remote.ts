import { RPC_WEB_PREFERENCES } from './preferences-remote.js'
import { RPC_WEB_MODEL_CATALOG } from './model-catalog-remote.js'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'

const PKG = '@lisihao/dsh-solar-chatgpt-web'

/**
 * The generated package artifact owns the boundary schemas.  The UI bundle
 * only needs the descriptor metadata and therefore keeps the codecs lazy,
 * matching the rc.2 client contribution shape used by the native plugins.
 */
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

const resultType = (method: string): string => {
  if (method === 'status') return 'WebUiStatus'
  if (method === 'launch') return 'WebLaunchResult'
  return 'WebRunRecord'
}

export const RPC_REMOTE: TypertRemoteContribution = {
  package: PKG,
  descriptors: [...(['status', 'launch', 'observe', 'cancel', 'abandon'] as const).map(method => ({
    id: `${PKG}#solarChatGptWebControl/${method}`,
    service: 'solarChatGptWebControl',
    namespace: 'solarChatGptWebControl',
    method,
    invocation: { kind: 'direct' as const },
    parameters: method === 'status'
      ? []
      : [{ name: 'input', wire: 'input', source: 'json' as const, codec: codec(method === 'launch' ? 'WebLaunchInput' : method === 'abandon' ? 'WebAbandonInput' : 'WebIdInput') }],
    result: codec(resultType(method)),
  })), ...RPC_WEB_PREFERENCES.descriptors, ...RPC_WEB_MODEL_CATALOG.descriptors],
}
