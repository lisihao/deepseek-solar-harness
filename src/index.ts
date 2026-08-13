/**
 * DSH host plugin registering an image-capable provider backed by Luna visual
 * transcription and an existing text-only DeepSeek provider.
 */
import type { Context } from 'cordis'
import { LunaVisionBridgeAdapter } from './adapter.js'
import { Config, resolveConfig } from './config.js'
import type { Config as ConfigShape } from './config.js'

export { LunaVisionBridgeAdapter } from './adapter.js'
export type { LunaVisionBridgeDeps } from './adapter.js'
export { Config, resolveConfig } from './config.js'
export type { Config as ConfigShape, ResolvedConfig } from './config.js'
export { LunaVision, parseCodexJsonl } from './vision.js'
export type { LunaVisionDeps, VisionCommand } from './vision.js'

/** Cordis plugin id used in loader diagnostics. */
export const name = '@dsh-external/dsh-luna-vision-bridge'

/** Services needed to resolve target models and read durable images. */
export const inject = ['llm', 'attachments']

/**
 * Register the bridge provider. Provider and model selection then appear in
 * the stock DSH model selector without any client plugin.
 * @param ctx - DSH host context carrying LLM and attachment services.
 * @param config - raw loader configuration.
 */
export function apply(ctx: Context, config: ConfigShape = {}): void {
  const resolved = resolveConfig(config)
  ctx.llm.registerAdapter([resolved.bridgeProvider], new LunaVisionBridgeAdapter({
    llm: ctx.llm,
    attachments: ctx.attachments,
    config: resolved,
  }))
}

export default apply
