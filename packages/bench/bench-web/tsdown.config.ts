import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@deepseek-ai/dsh-bench-web',
  ['lib/types/index.js', 'lib/types/invariant.js'],
  { hostPhase: true },
)
