/**
 * Format one canonical UTC timestamp in an explicit browser-resolved local zone.
 * @param value - canonical timestamp to display.
 * @param nowValue - canonical reference timestamp used for relative age.
 * @param timeZone - IANA time zone selected by the browser.
 * @returns absolute and relative user-facing time labels.
 */
export function formatLocalTimestamp(
  value: string,
  nowValue: string,
  timeZone: string,
): { absolute: string; relative: string } {
  const date = new Date(value)
  const referenceDate = new Date(nowValue)
  const timestamp = date.getTime()
  const reference = referenceDate.getTime()
  if (![timestamp, reference].every(Number.isFinite)) {
    return { absolute: '时间不可用', relative: '时间不可用' }
  }
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  })
  const fields = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]))
  const day = (candidate: Date): string => new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(candidate)
  const clock = `${fields.hour}:${fields.minute}:${fields.second} ${fields.timeZoneName}`
  return {
    absolute: day(date) === day(referenceDate) ? `今天 ${clock}` : `${fields.year}-${fields.month}-${fields.day} ${clock}`,
    relative: elapsedLabel(timestamp, reference),
  }
}

function elapsedLabel(value: number, reference: number): string {
  const minutes = Math.max(0, Math.floor((reference - value) / 60_000))
  if (minutes === 0) return '刚刚'
  if (minutes < 60) return `${String(minutes)} 分钟前`
  const hours = Math.floor(minutes / 60)
  return hours < 24
    ? `${String(hours)} 小时 ${String(minutes % 60)} 分钟前`
    : `${String(Math.floor(hours / 24))} 天前`
}
