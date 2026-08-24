/** Format one canonical UTC timestamp in an explicit browser-resolved local zone. */
export function formatLocalTimestamp(
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
  return `${String(Math.floor(hours / 24))} 天前`
}
