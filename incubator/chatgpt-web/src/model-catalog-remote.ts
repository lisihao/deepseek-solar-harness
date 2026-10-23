import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type {
  WebModelCatalog,
  WebModelCatalogApi,
  WebModelCatalogRefreshInput,
} from './model-catalog.js'

const PKG = '@lisihao/dsh-solar-chatgpt-web'

/**
 * The client bundle does not carry the server-side catalogue schema.  The
 * owner Remote layer supplies the value and the generated package validates
 * it; these descriptors only describe the public wire boundary.
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

export interface WebModelCatalogWire {
  read(): Promise<RemoteResult<WebModelCatalog | undefined>>
  refresh(input: WebModelCatalogRefreshInput): Promise<RemoteResult<WebModelCatalog>>
}

export function unwrapModelCatalogRemote<T>(result: RemoteResult<T>): T {
  if (result.ok) return result.value
  throw result.error
}

export function createWebModelCatalogApi(wire: WebModelCatalogWire): WebModelCatalogApi {
  return {
    read: async () => unwrapModelCatalogRemote(await wire.read()),
    refresh: async input => unwrapModelCatalogRemote(await wire.refresh(input)),
  }
}

/** Owner-only catalogue methods used by the settings view. */
export const RPC_WEB_MODEL_CATALOG: TypertRemoteContribution = {
  package: PKG,
  descriptors: [
    {
      id: `${PKG}#solarWebModelCatalog/read`,
      service: 'solarWebModelCatalog',
      namespace: 'solarWebModelCatalog',
      method: 'read',
      invocation: { kind: 'direct' as const },
      parameters: [],
      result: codec('WebModelCatalog'),
    },
    {
      id: `${PKG}#solarWebModelCatalog/refresh`,
      service: 'solarWebModelCatalog',
      namespace: 'solarWebModelCatalog',
      method: 'refresh',
      invocation: { kind: 'direct' as const },
      parameters: [{ name: 'input', wire: 'input', source: 'json' as const, codec: codec('WebModelCatalogRefreshInput') }],
      result: codec('WebModelCatalog'),
    },
  ],
}
