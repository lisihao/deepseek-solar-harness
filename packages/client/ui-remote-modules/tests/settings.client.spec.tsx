// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteModulesConfig } from '../src/contract.ts'
import { RemoteModulesSettings, type RemoteModulesSettingsProps } from '../src/client/RemoteModulesSettings.tsx'
import { validateRemoteModuleDrafts, type RemoteModuleDraft } from '../src/client/settings-draft.ts'
import { zh, type RemoteModulesSettingsKey } from '../src/client/settings-locales.ts'

afterEach(cleanup)

const configured: RemoteModulesConfig = {
  instances: [
    { id: 'research-workspace', label: 'Research Workspace', url: 'http://127.0.0.1:19001/', relayPort: 29001, order: 100 },
    { id: 'model-console', label: 'Model Console', url: 'http://127.0.0.1:19002/console/', relayPort: 29002, order: 200 },
  ],
}

function draft(overrides: Partial<RemoteModuleDraft> = {}): RemoteModuleDraft {
  return {
    key: 'one', id: 'research-workspace', label: 'Research Workspace', url: 'http://127.0.0.1:19001/',
    relayPort: '29001', order: '100', ...overrides,
  }
}

function renderEditor() {
  const settings = stubSettingsScope<RemoteModulesConfig>()
  settings.publish({
    status: 'ready', value: configured, base: configured, user: undefined,
    revision: 0, writable: true,
  })
  const t = (key: RemoteModulesSettingsKey): string => zh[key]
  render(<RemoteModulesSettings {...({ scope: settings.scope, t } as RemoteModulesSettingsProps)} />)
  return settings
}

describe('Remote Modules settings validation', () => {
  it('accepts a complete instance and rejects duplicate ids, ports, malformed URLs, and decimals', () => {
    expect(validateRemoteModuleDrafts([draft()]).config).toEqual({
      instances: [{
        id: 'research-workspace', label: 'Research Workspace', url: 'http://127.0.0.1:19001/', relayPort: 29001, order: 100,
      }],
    })
    const invalid = validateRemoteModuleDrafts([
      draft(),
      draft({ key: 'two', url: 'javascript:alert(1)', relayPort: '29001', order: '1.5' }),
    ])
    expect(invalid.config).toBeUndefined()
    expect(invalid.errors.one).toMatchObject({ id: 'duplicateId', relayPort: 'duplicatePort' })
    expect(invalid.errors.two).toMatchObject({
      id: 'duplicateId', url: 'invalidUrl', relayPort: 'duplicatePort', order: 'invalidOrder',
    })
  })

  it('rejects every incomplete draft field without coercing browser text input', () => {
    expect(validateRemoteModuleDrafts([])).toEqual({ errors: {} })
    const invalid = validateRemoteModuleDrafts([
      draft({
        id: '  ', label: '  ', url: 'not a url', relayPort: 'not-a-port', order: 'not-an-order',
      }),
      draft({
        key: 'two', id: 'Not Valid', url: 'ftp://example.test', relayPort: '65536', order: '1.5',
      }),
      draft({
        key: 'three', id: 'credentials', url: 'https://user:secret@example.test', relayPort: '0', order: '-1',
      }),
    ])
    expect(invalid.config).toBeUndefined()
    expect(invalid.errors.one).toEqual({
      id: 'required', label: 'required', url: 'invalidUrl', relayPort: 'invalidPort', order: 'invalidOrder',
    })
    expect(invalid.errors.two).toEqual({
      id: 'invalidId', url: 'invalidUrl', relayPort: 'invalidPort', order: 'invalidOrder',
    })
    expect(invalid.errors.three).toEqual({ url: 'invalidUrl' })
  })
})

describe('Remote Modules settings surface', () => {
  it('shows every required configuration field and can add or delete instances', async () => {
    renderEditor()
    await screen.findByDisplayValue('Research Workspace')
    expect(screen.getAllByText('实例 ID')).toHaveLength(2)
    expect(screen.getAllByText('显示名称')).toHaveLength(2)
    expect(screen.getAllByText('目标网页地址')).toHaveLength(2)
    expect(screen.getAllByText('本机中继端口')).toHaveLength(2)
    expect(screen.getAllByText('侧栏顺序')).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: '增加模块' }))
    expect(screen.getByDisplayValue('Web page 3')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: '删除模块' })[2]!)
    expect(screen.queryByDisplayValue('Web page 3')).toBeNull()
  })

  it('saves the complete instances array and reports restart application', async () => {
    const settings = renderEditor()
    settings.set.mockImplementation((_field: string, value: unknown) => {
      const instances = value as RemoteModulesConfig['instances']
      settings.publish({ value: { instances }, user: { instances }, revision: 1 })
    })
    const label = await screen.findByDisplayValue('Research Workspace')
    fireEvent.change(label, { target: { value: 'Research Workspace A' } })
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }))

    await waitFor(() => {
      expect(settings.set).toHaveBeenCalledWith('instances', [
        { ...configured.instances[0]!, label: 'Research Workspace A' },
        configured.instances[1],
      ])
    })
    expect(await screen.findByText('配置已保存；重启 Harness 后生效。')).toBeTruthy()
  })

  it('restores the deployment instances by clearing the user override', async () => {
    const settings = renderEditor()
    settings.unset.mockImplementation(() => {
      settings.publish({ value: configured, user: {}, revision: 1 })
    })
    await screen.findByDisplayValue('Research Workspace')
    fireEvent.click(screen.getByRole('button', { name: '恢复部署默认值' }))
    await waitFor(() => { expect(settings.unset).toHaveBeenCalledWith('instances') })
    expect(await screen.findByText('配置已保存；重启 Harness 后生效。')).toBeTruthy()
  })
})
