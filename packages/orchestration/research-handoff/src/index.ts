/** Research Service Definition; local data never substitutes for a current trusted embedding Host. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ResearchHostPolicy, ResearchHostRegistration, ResearchHostScope } from './control.ts'
import type { ResearchPlatformDriver } from './driver.ts'
import type { ResearchSourceAccess, ResearchSourceReader } from './source.ts'

export * from './api.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Owner-scoped research control and explicit Driver registration. */
    researchHandoff: ResearchHandoffService
  }
}

/** Complete research control seam; implementing this Definition does not establish website compatibility. */
export abstract class ResearchHandoffService extends Service {
  constructor(ctx: Context) {
    if (new.target === ResearchHandoffService) throw new Error('research-handoff is an abstract seam; load a Provider')
    super(ctx, 'researchHandoff')
  }

  /**
   * Bind an explicit current-process Host; never expose this registration through model or generic JSON RPC.
   * @param host - Trusted embedding Context owning the grant lifecycle.
   * @param policy - Explicit deployment/Host bounds, independent of imported policy or saved confirmations.
   * @param sourceAccess - Optional explicit live source controls; absence disables source Reader execution.
   * @param scope - Optional trusted lifecycle check, called on reads and existing external-operation guards.
   * @returns Current callable control and owned revocation; arbitrary trusted same-process plugins share this trust domain.
   */
  abstract bindHost(host: Context, policy: ResearchHostPolicy, sourceAccess?: ResearchSourceAccess,
    scope?: ResearchHostScope): ResearchHostRegistration

  /**
   * Register an explicit source Reader under its contribution lifecycle.
   * @param owner - Trusted Reader lifecycle.
   * @param reader - Explicit adapter obeying initial and redirect access guards.
   * @returns Owned registration disposal, without cancelling already accepted remote work.
   */
  abstract registerSourceReader(owner: Context, reader: ResearchSourceReader): () => Promise<void>

  /**
   * Register one explicitly selected Driver under its plugin lifecycle.
   * @param owner - Context owning this Driver registration.
   * @param driver - Actual platform implementation; unknown website interfaces remain unavailable.
   * @returns Owned registration disposal, without automatic Driver replacement or fallback.
   */
  abstract registerDriver(owner: Context, driver: ResearchPlatformDriver): () => Promise<void>
}

export default ResearchHandoffService
