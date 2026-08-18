import type {
  DesktopResidentActivity,
  DesktopResidentEvent,
} from './resident-dashboard-contracts.ts'

const LEGACY_TASK_LABEL = '历史任务（升级前未记录摘要）'

/** Keep known local acceptance workspaces out of the user task surface. */
export function isDiagnosticResidentWorkspace(workspace: string): boolean {
  const normalized = workspace.replaceAll('\\', '/')
  return normalized.includes('/.dsh/artifacts/resident-dev-canary/')
    || /\/(?:private\/)?tmp\/dsh-(?:resident|profile|packaged)-/u.test(normalized)
}

/** Collapse low-level daemon events into one user-facing row per durable turn. */
export function buildResidentActivities(events: readonly DesktopResidentEvent[]): DesktopResidentActivity[] {
  const activities = new Map<string, DesktopResidentActivity>()
  for (const event of events) {
    const commandId = stringData(event.data.commandId)
    const turnId = stringData(event.data.turnId)
    if (commandId === undefined || turnId === undefined || !event.type.startsWith('turn.')) continue
    const previous = activities.get(turnId)
    const taskLabel = stringData(event.data.taskLabel) ?? previous?.taskLabel ?? LEGACY_TASK_LABEL
    const status = activityStatus(event, previous?.status)
    const phase = event.type === 'turn.progress' ? stringData(event.data.phase) : previous?.phase
    const next: DesktopResidentActivity = {
      commandId,
      turnId,
      taskLabel,
      status,
      startedAt: previous?.startedAt ?? event.time,
      updatedAt: event.time,
      ...status === 'running' && phase !== undefined ? { phase } : {},
    }
    activities.set(turnId, next)
  }
  return [...activities.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

/** Format one canonical UTC timestamp in an explicit browser-resolved local zone. */
export function formatResidentTimestamp(
  value: string,
  nowValue: string,
  timeZone: string,
): { absolute: string; relative: string } {
  const date = new Date(value)
  const now = new Date(nowValue)
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(now.getTime())) {
    return { absolute: '时间不可用', relative: '时间不可用' }
  }
  const fields = dateFields(date, timeZone)
  const nowFields = dateFields(now, timeZone)
  const sameDay = fields.year === nowFields.year && fields.month === nowFields.month && fields.day === nowFields.day
  const clock = `${fields.hour}:${fields.minute}:${fields.second} ${fields.zone}`
  return {
    absolute: sameDay ? `今天 ${clock}` : `${fields.year}-${fields.month}-${fields.day} ${clock}`,
    relative: relativeAge(date.getTime(), now.getTime()),
  }
}

function activityStatus(
  event: DesktopResidentEvent,
  previous: DesktopResidentActivity['status'] | undefined,
): DesktopResidentActivity['status'] {
  if (event.type === 'turn.accepted') return 'queued'
  if (event.type === 'turn.running' || event.type === 'turn.progress') return 'running'
  if (event.type === 'turn.indeterminate') return 'indeterminate'
  if (event.type === 'turn.failed') return event.data.code === 'OPERATOR_ABORTED' ? 'interrupted' : 'failed'
  if (event.type === 'turn.settled') {
    if (event.data.stopReason === 'completed') return 'completed'
    if (event.data.stopReason === 'aborted') return 'interrupted'
    return 'failed'
  }
  return previous ?? 'running'
}

function stringData(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function dateFields(date: Date, timeZone: string): Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second' | 'zone', string> {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes): string => parts.find(part => part.type === type)?.value ?? ''
  return {
    year: value('year'), month: value('month'), day: value('day'),
    hour: value('hour'), minute: value('minute'), second: value('second'),
    zone: value('timeZoneName'),
  }
}

function relativeAge(value: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - value) / 1000))
  if (seconds < 60) return '刚刚'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${String(minutes)} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${String(hours)} 小时 ${String(minutes % 60)} 分钟前`
  const days = Math.floor(hours / 24)
  return `${String(days)} 天前`
}
