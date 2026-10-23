import { expect, test } from 'vitest'
import { canAbandon } from '../src/client.js'
import { WEB_ABANDON_CONFIRMATION, WEB_STAGE_LABELS } from '../src/ui-contract.js'

test('the UI offers local retirement only for an idle indeterminate run', () => {
  expect(canAbandon('indeterminate', false, false)).toBe(true)
  expect(canAbandon('indeterminate', true, false)).toBe(false)
  expect(canAbandon('indeterminate', false, true)).toBe(false)
  expect(canAbandon('completed', false, false)).toBe(false)
  expect(canAbandon('abandoned', false, false)).toBe(false)
  expect(WEB_STAGE_LABELS.abandoned).toBe('已结束本地跟踪（远端结果未知）')
  expect(WEB_ABANDON_CONFIRMATION).toBe('仅结束本地跟踪、保留远端结果未知，不取消远端、不重发；确认后新任务才能运行')
})
