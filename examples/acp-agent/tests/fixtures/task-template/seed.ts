import type { Context } from '@deepseek-ai/cordis'
import { taskTemplateId } from '@deepseek-ai/dsh-task-template'
import type {} from '@deepseek-ai/dsh-task-template-context'

export const name = 'task-template-fixture-seed'
export const inject = ['taskTemplates']

/** Fixed template id this fixture always seeds, so scenario transcripts stay deterministic. */
export const FIXTURE_TEMPLATE_ID = taskTemplateId('acp-fixture-playbook')

/** Fictional method text with no live-provider dependency; safe for a keyless scenario. */
const FIXTURE_METHOD = 'Follow the fixture playbook for {{objective}}: outline, verify, conclude.'

/**
 * Seed one deterministic task template before the scenario's first request, so
 * a keyless ACP example scenario exercises real selection and injection
 * through `ctx.taskTemplates` without depending on load order across
 * `cordis.yml` entries.
 */
export async function apply(ctx: Context): Promise<void> {
  await ctx.taskTemplates.create({
    id: FIXTURE_TEMPLATE_ID,
    name: 'ACP fixture playbook',
    method: FIXTURE_METHOD,
  })
}
