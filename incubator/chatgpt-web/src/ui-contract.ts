import type { WebRunRecord, WebRunRequest } from './store.js'

/** State returned by the owner-only UI control service.
 *
 * `activeIds` is intentionally separate from `runs`: a controller can know
 * that a run is still active before its latest durable record is available.
 */
export interface WebUiStatus {
  readonly runs: readonly WebRunRecord[]
  readonly activeIds: readonly string[]
  readonly errors: readonly { readonly id: string; readonly message: string }[]
}

export interface WebLaunchInput {
  readonly id: string
  readonly request: WebRunRequest
}

export interface WebIdInput {
  readonly id: string
}

/** Explicit owner acknowledgement for retiring an idle indeterminate run. */
export interface WebAbandonInput {
  readonly id: string
  readonly expectedRevision: number
  readonly acknowledgeUnknown: true
}

/** Public direct Remote methods consumed by the browser client. */
export interface ChatGptWebControlApi {
  status(): Promise<WebUiStatus>
  launch(input: WebLaunchInput): Promise<{ readonly id: string }>
  observe(input: WebIdInput): Promise<WebRunRecord>
  cancel(input: WebIdInput): Promise<WebRunRecord>
  abandon(input: WebAbandonInput): Promise<WebRunRecord>
}

export const WEB_ABANDON_CONFIRMATION = '仅结束本地跟踪、保留远端结果未知，不取消远端、不重发；确认后新任务才能运行'

export const WEB_STAGE_LABELS: Readonly<Record<WebRunRecord['stage'], string>> = {
  prepared: '已创建，等待网页准备',
  ready: '网页已准备，等待提交',
  'submission-unknown': '提交结果未确认',
  submitted: '已提交，等待网页回答',
  completed: '已完成',
  blocked: '等待人工处理',
  indeterminate: '执行结果未确认',
  failed: '执行失败',
  cancelled: '已请求停止',
  abandoned: '已结束本地跟踪（远端结果未知）',
}
