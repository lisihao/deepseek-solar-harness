import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@deepseek-ai/dsh-ui-orchestration',
  ['lib/types/index.js', 'lib/types/invariant.js'],
  { hostPhase: true },
)
