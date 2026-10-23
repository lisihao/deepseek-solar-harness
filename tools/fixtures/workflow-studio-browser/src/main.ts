import { createElement, useSyncExternalStore, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { SettingsFixture } from './settings.js'
import { SessionModeControl, WorkflowStudioPanel } from '../../../../incubator/native-collaboration/src/studio-client.js'
import { FakeStudioUiApi, SESSION_ID, type WorkflowStudioFixtureCounters } from './fake-api.js'

export interface WorkflowStudioFixtureWindow {
  readonly sessionId: string
  readonly api: FakeStudioUiApi
  readonly counters: WorkflowStudioFixtureCounters
  snapshot(): ReturnType<FakeStudioUiApi['snapshot']>
  styleContainment(): { readonly outsideFlowStrokeDefault: string | undefined }
}

declare global {
  interface Window {
    __dshWorkflowStudioFixture?: WorkflowStudioFixtureWindow
  }
}

const api = new FakeStudioUiApi({
  emptyOverview: new URLSearchParams(window.location.search).get('empty') === '1',
  ...new URLSearchParams(window.location.search).get('smartBlocked') === '1'
    ? { smartBlockedMessage: 'Resident 调度器未运行，不能启用智能协同。' }
    : {},
})

function FixtureCounters(): ReactElement {
  useSyncExternalStore(api.subscribe, api.getVersion, api.getVersion)
  const counters = api.counters
  return createElement('aside', {
    style: {
      display: 'grid', gap: 6, padding: 12, margin: 12,
      border: '1px solid #485266', borderRadius: 8, color: '#dde4ef', background: '#1b2029',
    },
    'aria-label': 'Fixture effect counters',
  }, [
    createElement('strong', { key: 'title' }, 'Fixture 计数器'),
    createElement('span', { key: 'hint', style: { color: '#aeb9c9' } }, '刷新、编辑、保存、检查和模式选择不启动模型；续接只使用原执行身份并计入 resumes。'),
    ...Object.entries(counters).map(([key, value]) => createElement('span', { key, 'data-fixture-counter': key }, `${key}: ${value}`)),
  ])
}

function FlowStyleContainmentSentinel(): ReactElement {
  return createElement('aside', {
    style: {
      display: 'grid', gap: 4, padding: 12, margin: 12,
      border: '1px dashed #59677c', borderRadius: 8, color: '#dde4ef', background: '#171c25',
    },
  }, [
    createElement('strong', { key: 'title' }, 'React Flow 样式隔离哨兵'),
    createElement('span', { key: 'hint', style: { color: '#aeb9c9' } }, '此面板外的 .react-flow 不应获得流程编辑器的 XYFlow 自定义属性。'),
    createElement('div', { key: 'flow', className: 'react-flow', 'data-react-flow-sentinel': 'outside' }, 'outside .react-flow'),
  ])
}

/** Approximates the composer tool row so the mode toggle is inspected beside its real neighbours. */
function ComposerToolRow(): ReactElement {
  const neighbour = { color: '#aeb9c9', fontSize: 13, padding: '0 8px', height: 28, display: 'inline-flex', alignItems: 'center' }
  return createElement('div', {
    'data-fixture-composer': 'true',
    style: { margin: '48px 16px 8px', padding: '10px 12px', border: '1px solid #2c3442', borderRadius: 16, background: '#1c222c', display: 'grid', gap: 10 },
  }, [
    createElement('div', { key: 'editor', style: { color: '#6f7b8c', fontSize: 14 } }, '输入消息…'),
    createElement('div', { key: 'tools', style: { display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 } }, [
      createElement('span', { key: 'plus', style: neighbour }, '+'),
      createElement('span', { key: 'permission', style: neighbour }, '完全权限 ▾'),
      createElement(SessionModeControl, { key: 'mode', sessionId: SESSION_ID, api }),
      createElement('span', { key: 'spacer', style: { flex: 1 } }),
      createElement('span', { key: 'model', style: neighbour }, 'GPT-6-Sol ▾'),
    ]),
  ])
}

function FixtureApp(): ReactElement {
  return createElement('div', { style: { minWidth: 0 } }, [
    createElement('header', { key: 'header', style: { padding: '16px 16px 4px', color: '#f1f5fb' } }, [
      createElement('h1', { key: 'title', style: { margin: 0, fontSize: '1.2rem' } }, 'Workflow Studio local browser fixture'),
      createElement('p', { key: 'summary', style: { margin: '6px 0 0', color: '#aeb9c9' } }, '仅使用内存假 API；不会访问网络、安装应用或调用真实模型。'),
    ]),
    createElement(ComposerToolRow, { key: 'composer' }),
    createElement(FixtureCounters, { key: 'counters' }),
    createElement(FlowStyleContainmentSentinel, { key: 'flow-sentinel' }),
    createElement(WorkflowStudioPanel, { key: 'panel', sessionId: SESSION_ID, api }),
  ])
}

const root = document.getElementById('root')
if (root === null) throw new Error('Fixture root is missing.')

window.__dshWorkflowStudioFixture = {
  sessionId: SESSION_ID,
  api,
  counters: api.counters,
  snapshot: () => api.snapshot(),
  styleContainment: () => {
    const sentinel = document.querySelector<HTMLElement>('[data-react-flow-sentinel="outside"]')
    return { outsideFlowStrokeDefault: sentinel === null ? undefined : getComputedStyle(sentinel).getPropertyValue('--xy-edge-stroke-default') || undefined }
  },
}
createRoot(root).render(createElement(new URLSearchParams(window.location.search).get('view') === 'settings' ? SettingsFixture : FixtureApp))
