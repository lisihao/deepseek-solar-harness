/** Trusted Host RPC that serves the scheduling evidence store to the settings page. */
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler, HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { SchedulingEvidenceGateway } from '@deepseek-ai/dsh-scheduling-evidence'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import {
  SCHEDULING_EVIDENCE_RPC_CHANNEL,
  type PublicEvidenceModeView,
  type SchedulingEvidencePageV1,
} from './shared.ts'

export { SCHEDULING_EVIDENCE_RPC_CHANNEL } from './shared.ts'
export type * from './shared.ts'

/** Cordis function-plugin name. */
export const name = 'scheduling-evidence-rpc'
/** Services required to expose the scheduling evidence RPC channel. */
export const inject = ['schedulingEvidence', 'connection']

type RpcResult = Awaited<ReturnType<ConnectionRpcHandler>>

const ALLOCATION_NAMESPACE = settingsNamespace('model-allocation')

function evidenceMode(settings: SettingsProvider | undefined): PublicEvidenceModeView | null {
  const mode = (settings?.get(ALLOCATION_NAMESPACE) as { publicEvidence?: unknown } | undefined)?.publicEvidence
  return mode === 'off' || mode === 'shadow' || mode === 'apply' ? mode : null
}

/**
 * Create the endpoint dispatcher used by Host composition and tests. The only endpoint is
 * `overview`, takes no payload, and changes nothing.
 * @param gateway - the evidence gateway that reads the Radar store.
 * @param settings - the user-settings provider, when one is mounted.
 * @returns a handler that returns the page payload or a bad-request failure.
 */
export function createSchedulingEvidenceRpcHandler(
  gateway: Pick<SchedulingEvidenceGateway, 'overview'>,
  settings?: SettingsProvider,
): ConnectionRpcHandler {
  return async (endpoint, payload): Promise<RpcResult> => {
    try {
      if (endpoint !== 'overview') throw new TypeError(`unknown scheduling-evidence endpoint: ${endpoint}`)
      if (payload !== undefined && (typeof payload !== 'object' || payload === null || Object.keys(payload).length > 0)) {
        throw new TypeError('payload must be empty')
      }
      const page: SchedulingEvidencePageV1 = { ...await gateway.overview(), publicEvidence: evidenceMode(settings) }
      return { ok: true, value: page }
    } catch (error) {
      return {
        ok: false,
        error: { code: 'bad-request', message: error instanceof Error ? error.message : String(error), details: { issues: [] } },
      }
    }
  }
}

/**
 * Register the read-only evidence channel on the authenticated trusted-Host RPC.
 * @param ctx - Cordis context carrying the evidence gateway and Connection services.
 * @returns nothing; the handler registration belongs to the plugin fiber.
 */
export function apply(ctx: Context): void {
  const connection = ctx.get('connection') as HostConnectionHandle
  ctx.effect(
    () => connection.rpc.handle(
      SCHEDULING_EVIDENCE_RPC_CHANNEL,
      createSchedulingEvidenceRpcHandler(ctx.schedulingEvidence, ctx.get('settings')),
      { authority: 'trusted-host' },
    ),
    'scheduling-evidence-rpc: trusted read channel',
  )
}
