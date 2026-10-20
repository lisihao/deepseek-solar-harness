import { createElement, useSyncExternalStore, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
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

const api = new FakeStudioUiApi()

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

function FixtureApp(): ReactElement {
  return createElement('div', { style: { minWidth: 0 } }, [
    createElement('header', { key: 'header', style: { padding: '16px 16px 4px', color: '#f1f5fb' } }, [
      createElement('h1', { key: 'title', style: { margin: 0, fontSize: '1.2rem' } }, 'Workflow Studio local browser fixture'),
      createElement('p', { key: 'summary', style: { margin: '6px 0 0', color: '#aeb9c9' } }, '仅使用内存假 API；不会访问网络、安装应用或调用真实模型。'),
      createElement(SessionModeControl, { key: 'mode', sessionId: SESSION_ID, api }),
    ]),
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
createRoot(root).render(createElement(FixtureApp))
