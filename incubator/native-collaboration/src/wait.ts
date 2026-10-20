import { setTimeout as delay } from 'node:timers/promises'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { GraphSnapshot, ResidentApi } from '@lisihao/dsh-solar-native-resident/contracts'

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'indeterminate'])
/** Local observation only: a cancelled wait never cancels or resubmits the graph. */
export async function waitForGraph(resident: Pick<ResidentApi, 'inspect'>, graphId: string, waitMs: number, signal: AbortSignal): Promise<GraphSnapshot> {
  if (typeof graphId !== 'string' || !graphId.trim() || graphId.length > 256) throw new Error('GRAPH_ID_INVALID: 请提供原任务图的有效引用。')
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 60_000) throw new Error('WAIT_BOUND_INVALID: 本地等待范围为 0 到 60000 毫秒。')
  const deadline = Date.now() + waitMs
  for (;;) {
    signal.throwIfAborted()
    const snapshot = await resident.inspect(graphId)
    signal.throwIfAborted()
    if (TERMINAL.has(snapshot.status) || Date.now() >= deadline) return snapshot
    await delay(Math.min(1000, Math.max(1, deadline - Date.now())), undefined, { signal })
  }
}
export function createWaitTool(resident: () => ResidentApi): ToolDefinition {
  return defineTool({
    name: 'solar_wait',
    description: 'Observe one already submitted TaskGraph for up to 60 seconds without model polling or another submission. Returns its actual snapshot and full outputs. A wait timeout or local cancellation does not cancel native work; inspect the same graph again. Unknown effects must never be retried automatically.',
    parameters: {
      graph_id: { type: 'string', required: true, description: 'Exact graph reference from the original submission.' },
      wait_ms: { type: 'integer', description: 'Local observation window, 0–60000 ms; default 60000.' },
    },
    presentCall: () => ({ card: 'generic', kind: 'read', title: '等待协同任务结果' }),
    presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? '本地等待未完成' : '已读取原任务结果', content: [{ type: 'text', text: '协调者将按实际执行状态继续处理；本地等待结束不代表全部任务完成，也不会重新提交任务。' }] }),
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', required: true }, snapshot: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: [
        value.status === 'completed' ? '任务图已完成执行；请核对产物和验证证据后交付。' : value.status === 'indeterminate' ? '执行效果尚未确定；保留原任务，不得自动重新提交。' : '已读取原任务状态；如仍未完成，请继续等待同一任务，不能将提交当作成功。',
        value.snapshot,
      ].join('\n') }],
    },
    async execute(args, exec) { const snapshot = await waitForGraph(resident(), args.graph_id, args.wait_ms ?? 60_000, exec.signal); return { status: snapshot.status, snapshot: JSON.stringify(snapshot) } },
  })
}
