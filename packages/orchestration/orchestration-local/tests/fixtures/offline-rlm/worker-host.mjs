/** Load the real Worker exports from a fixture package that already declares both dependencies. */
import assert from 'node:assert/strict'
import ModelWorkers from '@deepseek-ai/dsh-model-worker'
import DeepSeekWorker from '@deepseek-ai/dsh-model-worker-deepseek'

export const name = 'offline-real-worker-host'
export const inject = ['llm']
export async function apply(ctx) {
  if (process.env.DSH_EXAMPLE_MODE === 'lib') {
    for (const id of ['@deepseek-ai/dsh-model-worker', '@deepseek-ai/dsh-model-worker-deepseek']) {
      assert.match(import.meta.resolve(id), /\/lib\/index\.js$/)
    }
  }
  await ctx.plugin(ModelWorkers)
  await ctx.plugin(DeepSeekWorker)
}
