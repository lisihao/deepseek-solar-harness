import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'

const PKG = '@lisihao/dsh-solar-native-collaboration'

function codec(typeSymbol: string) {
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

const methods = [
  ['overview', 'StudioOverviewInput', 'StudioOverview'],
  ['refreshSource', 'StudioRefreshSourceInput', 'StudioSource'],
  ['save', 'StudioSaveInput', 'StudioDraft'],
  ['validate', 'StudioValidateInput', 'StudioIssues'],
  ['run', 'StudioRunInput', 'StudioRunRecord'],
  ['inspect', 'StudioInspectInput', 'StudioRunRecord'],
  ['resume', 'StudioResumeInput', 'StudioRun'],
  ['setMode', 'StudioModeInput', 'CollaborationModeState'],
] as const

/** Public descriptors for root TYPERT composition; StudioControl validates each JSON boundary. */
export const STUDIO_RPC_REMOTE: TypertRemoteContribution = {
  package: PKG,
  descriptors: methods.map(([method, input, result]) => ({
    id: `${PKG}#solarWorkflowControl/${method}`,
    service: 'solarWorkflowControl',
    namespace: 'solarWorkflowControl',
    method,
    invocation: { kind: 'direct' as const },
    parameters: [{ name: 'input', wire: 'input', source: 'json' as const, codec: codec(input) }],
    result: codec(result),
  })),
}

/** Alias kept short for TYPERT aggregators. */
export const STUDIO_REMOTE = STUDIO_RPC_REMOTE
