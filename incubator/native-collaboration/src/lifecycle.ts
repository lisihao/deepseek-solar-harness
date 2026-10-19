import type { SubagentActivation } from '@deepseek-ai/dsh-subagent'

/** Track only activations created by this plugin and observe their terminal outcome. */
export function trackOwnedActivation(
  activations: Set<SubagentActivation>,
  activation: SubagentActivation,
  warn: (message: string) => void,
): void {
  activations.add(activation)
  void activation.result
    .then((result) => {
      if (result.stopReason !== 'completed') {
        warn(`child ${String(activation.childId)} ended with ${result.stopReason}`)
      }
    })
    .catch((error: unknown) => {
      warn(`child ${String(activation.childId)} result unavailable: ${String(error)}`)
    })
    .finally(() => {
      activations.delete(activation)
    })
}

/** Dispose only the activations in the supplied plugin-owned set. */
export async function disposeOwnedActivations(activations: Set<SubagentActivation>): Promise<void> {
  const owned = [...activations]
  activations.clear()
  const results = await Promise.allSettled(owned.map((activation) => activation.dispose()))
  const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
  if (failures.length > 0) {
    throw new AggregateError(failures, 'native-collaboration activation cleanup failed')
  }
}
