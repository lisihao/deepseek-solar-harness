import { describe, expect, it } from 'vitest'
import {
  blankTarget, draftBlockers, draftFromValue, draftToPatch,
} from '../src/client/draft.js'
import { resolveConfig } from '../src/config.js'

describe('draftFromValue', () => {
  it('extracts providerName and targets from a resolved settings value', () => {
    const draft = draftFromValue({
      providerName: 'Luna Vision Bridge',
      targets: [
        { provider: 'deepseek-official', model: 'deepseek-v4-flash', name: 'Flash + Luna', bridgeModel: 'flash' },
        { provider: 'pi-ai', model: 'pi-coder' },
      ],
    })
    expect(draft).toEqual({
      providerName: 'Luna Vision Bridge',
      targets: [
        { provider: 'deepseek-official', model: 'deepseek-v4-flash', name: 'Flash + Luna', bridgeModel: 'flash' },
        { provider: 'pi-ai', model: 'pi-coder', name: '', bridgeModel: '' },
      ],
    })
  })

  it('prefills the visible legacy target when the section carries none', () => {
    expect(draftFromValue(undefined)).toEqual({
      providerName: '',
      targets: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash', name: '', bridgeModel: 'deepseek-v4-flash' }],
    })
    expect(draftFromValue({})).toEqual({
      providerName: '',
      targets: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash', name: '', bridgeModel: 'deepseek-v4-flash' }],
    })
  })

  it('drops malformed target rows', () => {
    const draft = draftFromValue({ targets: [{ provider: 'a', model: 'm' }, { model: 'missing-provider' }, 'junk'] })
    expect(draft.targets).toHaveLength(1)
    expect(draft.targets[0]).toMatchObject({ provider: 'a', model: 'm' })
  })
})

describe('draftBlockers', () => {
  it('requires a non-blank provider name (the reset button clears overrides)', () => {
    expect(draftBlockers({ providerName: '  ', targets: [] })[0]).toMatch(/^Provider 显示名不能为空/)
    expect(draftBlockers({ providerName: 'Luna Vision Bridge', targets: [] })).toEqual([])
  })

  it('names rows missing provider or model', () => {
    const blockers = draftBlockers({
      providerName: 'B',
      targets: [blankTarget(), { ...blankTarget(), provider: 'a', model: 'm' }],
    })
    expect(blockers).toContain('第 1 行缺少 provider')
    expect(blockers).toContain('第 1 行缺少 model')
    expect(blockers).not.toContain('第 2 行缺少 provider')
  })

  it('rejects duplicate explicit bridge model ids', () => {
    const blockers = draftBlockers({
      providerName: 'B',
      targets: [
        { ...blankTarget(), provider: 'a', model: 'm', bridgeModel: 'dup' },
        { ...blankTarget(), provider: 'b', model: 'm', bridgeModel: 'dup' },
      ],
    })
    expect(blockers).toContain('桥接模型 id "dup" 重复（含自动生成）')
  })

  it('rejects defaulted bridge model ids that collide like the Host would', () => {
    const blockers = draftBlockers({
      providerName: 'B',
      targets: [
        { ...blankTarget(), provider: 'a', model: 'm' },
        { ...blankTarget(), provider: 'a', model: 'm' },
      ],
    })
    expect(blockers).toContain('桥接模型 id "a-m" 重复（含自动生成）')
  })

  it('rejects a defaulted id colliding with an explicit one', () => {
    const blockers = draftBlockers({
      providerName: 'B',
      targets: [
        { ...blankTarget(), provider: 'a', model: 'm' },
        { ...blankTarget(), provider: 'x', model: 'y', bridgeModel: 'a-m' },
      ],
    })
    expect(blockers).toContain('桥接模型 id "a-m" 重复（含自动生成）')
  })

  it('passes a complete draft', () => {
    expect(draftBlockers({
      providerName: 'Luna Vision Bridge',
      targets: [{ ...blankTarget(), provider: 'a', model: 'm' }],
    })).toEqual([])
  })
})

describe('draftToPatch', () => {
  it('preserves the zero-config bridge model identity after saving the visible default', () => {
    const zeroConfig = resolveConfig({})
    const draft = draftFromValue({ providerName: zeroConfig.providerName })
    const savedConfig = resolveConfig(draftToPatch(draft))

    expect(savedConfig.targets[0]?.bridgeModel).toBe(zeroConfig.targets[0]?.bridgeModel)
  })

  it('trims values and omits blank optional fields', () => {
    expect(draftToPatch({
      providerName: '  My Bridge  ',
      targets: [
        { provider: ' a ', model: ' m ', name: ' N ', bridgeModel: ' b ' },
        { provider: 'x', model: 'y', name: '', bridgeModel: '' },
      ],
    })).toEqual({
      providerName: 'My Bridge',
      targets: [
        { provider: 'a', model: 'm', name: 'N', bridgeModel: 'b' },
        { provider: 'x', model: 'y' },
      ],
    })
  })

  it('always names targets so an empty list explicitly falls back to legacy', () => {
    expect(draftToPatch({ providerName: 'B', targets: [] })).toEqual({ providerName: 'B', targets: [] })
  })
})
