/**
 * Luna Vision Bridge settings section, browser half. Registers one
 * `settings.section` entry under the shell-declared slot so the Web Settings
 * page renders a form for the `luna-vision-bridge` namespace: downstream
 * targets and the bridge display name, saved through the settings domain.
 * The Host owns validation and live application; this face only edits the
 * user layer.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { LunaSection } from './LunaSection.tsx'
import type { LunaSectionInjected } from './LunaSection.tsx'

/** Required services (cordis fiber inject). The target slot is declared by ui-settings' apply. */
export const inject = ['slots', 'connection']

/**
 * Register the section once the `settings.section` declaration is on the
 * ledger. The injected face only carries the settings wire; the section
 * reads the namespace itself on first render.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  const injected = (): LunaSectionInjected => ({ api: connection.api })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'luna-vision-bridge',
    order: 20,
    label: 'Luna Vision Bridge',
    inject: injected,
  }, LunaSection))
}
