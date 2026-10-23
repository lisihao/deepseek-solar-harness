import type { GraphSnapshot, GraphStatus, Executor } from '@lisihao/dsh-solar-native-resident/contracts'

export interface NativeUiStatus {
  readonly checkedAt: string
  readonly resident: { readonly available: boolean; readonly message: string }
  readonly tools: readonly { readonly name: string; readonly available: boolean }[]
  readonly providers: readonly { readonly name: string; readonly label: string; readonly available: boolean }[]
  readonly graphs: readonly GraphSnapshot[]
}
export interface GraphQuery { readonly graphId: string }
export interface NativeControlInput { readonly graphId: string; readonly commandId: string; readonly expectedRevision: number; readonly action: 'pause' | 'resume' | 'cancel' }
export interface NativeTestInput { readonly commandId: string; readonly executor: Executor }
export interface NativeUiApi {
  status(): Promise<NativeUiStatus>
  inspect(input: GraphQuery): Promise<GraphSnapshot>
  control(input: NativeControlInput): Promise<GraphSnapshot>
  test(input: NativeTestInput): Promise<GraphSnapshot>
}
export const GRAPH_LABELS: Record<GraphStatus, string> = { queued: '等待调度', running: '正在执行', paused: '已暂停后续调度', cancelling: '正在请求中断，尚未确认停止', completed: '原生执行已结束，仍需核对结果', failed: '执行失败', cancelled: '已取消', indeterminate: '执行结果未确认，请勿重复提交' }
