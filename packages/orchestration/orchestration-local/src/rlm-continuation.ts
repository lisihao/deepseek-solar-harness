/** What an RLM execution ends in after its last continuation. */
import type { PhysicalOperatorResult } from '@deepseek-ai/dsh-physical-operator'
import type { RlmChildExecutionResult } from '@deepseek-ai/dsh-rlm-runtime'

/**
 * The operator result an RLM execution ends in after its last continuation. A continuation that did not settle keeps
 * its own stop reason, and its partial output when it has one, so a failed or indeterminate continuation can no longer
 * be reported as a completed run.
 * @param continuation - the last continuation the runtime drained, when there was one.
 * @param previous - the result before that continuation.
 * @returns `previous` when there was no continuation, or when it settled without output; otherwise the continuation's
 *   stop reason (its own, or the one its status implies) with its output, or with `previous`'s output when it returned none.
 */
export function rlmContinuationResult(
  continuation: RlmChildExecutionResult | undefined,
  previous: PhysicalOperatorResult,
): PhysicalOperatorResult {
  if (continuation === undefined) return previous
  const stopReason = continuation.stopReason
    ?? (continuation.status === 'settled' ? 'completed' : continuation.status === 'failed' ? 'error' : 'aborted')
  if (continuation.output === undefined && stopReason === 'completed') return previous
  return { output: [...continuation.output ?? previous.output], stopReason }
}

/**
 * Whether an RLM result may be followed by another turn of the same execution. Only `completed` may: after `error`,
 * `aborted`, `max-tokens`, or `refusal` a later turn is not started, because its success would replace the real stop
 * reason and the partial output of the turn that did not finish.
 * @param result - the result of the last turn.
 * @returns whether the result is a success.
 */
export function rlmResultSucceeded(result: PhysicalOperatorResult): boolean {
  return result.stopReason === 'completed'
}
