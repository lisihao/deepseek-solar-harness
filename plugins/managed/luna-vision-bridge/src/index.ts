/**
 * DSH host plugin registering an image-capable provider backed by Luna visual
 * transcription and one or more existing text-only providers. The whole
 * configuration is also a user settings section (`luna-vision-bridge`), so
 * downstream targets are editable from the Web Settings UI without touching
 * any configuration file.
 */
import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { LunaVisionBridgeAdapter } from './adapter.js'
import { Config, resolveConfig } from './config.js'
import type { Config as ConfigShape, ResolvedConfig } from './config.js'

export { LunaVisionBridgeAdapter } from './adapter.js'
export type { LunaVisionBridgeDeps } from './adapter.js'
export { Config, resolveConfig } from './config.js'
export type { Config as ConfigShape, ResolvedConfig, ResolvedTarget, TargetConfig } from './config.js'
export { LunaVision, parseCodexJsonl } from './vision.js'
export type { LunaVisionDeps, VisionCommand } from './vision.js'

/** Cordis plugin id used in loader diagnostics. */
export const name = '@ycp424c/dsh-luna-vision-bridge'

/** User-settings namespace surfacing this plugin's configuration in the Web UI. */
export const NS = settingsNamespace('luna-vision-bridge')

/** Services needed to resolve target models and read durable images. */
export const inject = ['llm', 'attachments']

/**
 * Register the bridge provider and its settings section. Provider and model
 * selection then appear in the stock DSH model selector without any client
 * plugin, and the Web Settings UI can add downstream targets live.
 * @param ctx - DSH host context carrying LLM and attachment services.
 * @param config - raw loader configuration.
 */
export function apply(ctx: Context, config: ConfigShape = {}): void {
  let current: () => ConfigShape = () => config
  // The configuration the adapter serves: a candidate becomes the published
  // value only after every registry refresh succeeds, so a failed route swap
  // keeps serving the last good configuration.
  let published = resolveConfig(config)
  // During a synchronous registry refresh the adapter reads this staged
  // candidate, so `replace` captures the candidate's retry policy and
  // provider metadata instead of the previous generation's.
  let staged: ResolvedConfig | undefined

  const registration = ctx.llm.registerAdapter([published.bridgeProvider], new LunaVisionBridgeAdapter({
    llm: ctx.llm,
    attachments: ctx.attachments,
    config: () => staged ?? published,
  }))
  const directoryEntry = (value: ResolvedConfig) => [{
    provider: value.bridgeProvider,
    displayName: value.providerName,
    settingsNs: NS,
    settingsPath: [],
  }]
  const directory = ctx.llm.registerConfigurableProviders(directoryEntry(published))

  // DSH captures the retry policy at registration, and the policy follows the
  // target provider set (order-insensitive), so a provider-set change must
  // refresh it too.
  const providerFingerprint = (value: ResolvedConfig): string => (
    JSON.stringify([...new Set(value.targets.map(target => target.provider))].sort())
  )

  const sameRegistrationFacts = (a: ResolvedConfig, b: ResolvedConfig): boolean => (
    a.bridgeProvider === b.bridgeProvider
    && a.providerName === b.providerName
    && providerFingerprint(a) === providerFingerprint(b)
  )

  const ensureRegistrationFacts = (): void => {
    let candidate: ResolvedConfig
    try {
      candidate = resolveConfig(current())
    } catch (error) {
      // Beyond-schema constraints failed: refuse the candidate and keep
      // serving the last good configuration, saying so once per snapshot.
      ctx.logger.error('luna-vision-bridge: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return
    }
    if (sameRegistrationFacts(candidate, published)) {
      // No registry fact changed (route, provider name, retry-policy source):
      // publish directly; every other field is read live by the adapter.
      published = candidate
      return
    }
    staged = candidate
    try {
      registration.replace([candidate.bridgeProvider])
      try {
        directory.replace(directoryEntry(candidate))
      } catch (error) {
        // Compensate the already-swapped adapter route with the published
        // facts; a refused directory refresh leaves its entries untouched.
        staged = undefined
        try {
          registration.replace([published.bridgeProvider])
        } catch (rollbackError) {
          ctx.logger.error('luna-vision-bridge: route rollback failed after a refused directory refresh; the bridge keeps its previous configuration while the route may have moved')
          ctx.logger.error(rollbackError)
        }
        throw error
      }
    } catch (error) {
      // A refused route swap (e.g. the new bridgeProvider is already owned by
      // another adapter) must not strand the running adapter: the published
      // configuration and the registration keep their previous facts.
      staged = undefined
      ctx.logger.error('luna-vision-bridge: keeping the last good configuration after a failed registration refresh')
      ctx.logger.error(error)
      return
    }
    staged = undefined
    published = candidate
  }

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    validate: (value) => {
      // Reject a section the adapter could not act on: duplicate bridgeModel
      // ids or a target provider colliding with the bridge provider itself.
      resolveConfig(value)
    },
    onChange: ensureRegistrationFacts,
  })
}

export default apply
