import type { Context } from '@deepseek-ai/cordis'

/** Real Cordis Provider fixture proving that model-owned Skills execute trusted TypeScript. */
export default {
  name: 'prime-e2e-managed-skill-provider',
  inject: ['continualHarnessSkills'],
  apply(ctx: Context): void {
    ctx.continualHarnessSkills.register({
      moduleId: 'prime-e2e-skill-provider',
      callables: ['summarizeEvidence'],
      invoke: async ({ args }) => {
        const text = args.text
        return {
          summary: `skill:${typeof text === 'string' ? text : JSON.stringify(text ?? '')}`,
          source: 'trusted-typescript-provider',
        }
      },
    })
    ctx.continualHarnessSkills.register({
      moduleId: 'prime-e2e-replacement-skill-provider',
      callables: ['summarizeReplacement'],
      invoke: async ({ args }) => ({
        summary: `replacement:${typeof args.text === 'string' ? args.text : JSON.stringify(args.text ?? '')}`,
        source: 'live-catalog-replacement',
      }),
    })
  },
}
