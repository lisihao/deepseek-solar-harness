import { createElement, type ReactElement } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { Executor, GraphSnapshot, GraphStatus, NodeSnapshot } from '@lisihao/dsh-solar-native-resident/contracts'
import { NativeCollaborationPanel, RemoteAccessStore } from '../../../../incubator/native-collaboration/src/client.js'
import type { StudioUiApi } from '../../../../incubator/native-collaboration/src/studio-contract.js'
import type { NativeUiStatus } from '../../../../incubator/native-collaboration/src/ui-contract.js'

/** Host dark-theme values copied from @deepseek-ai/dsh-client-ui-theme 0.2.1-rc.2. */
const DARK_THEME = `
:root {
  --dsw-alias-label-primary: #f9fafb;
  --dsw-alias-label-secondary: #cfd3d6;
  --dsw-alias-label-tertiary: #adb2b8;
  --dsw-alias-border-l2: #ffffff1f;
  --dsw-alias-border-l3: #ffffff29;
  --dsw-alias-bg-base: #151517;
  --dsw-alias-bg-layer-1: #232324;
  --dsw-alias-interactive-bg-hover: #ffffff14;
  --dsw-alias-state-success-primary: #22c55e;
  --dsw-alias-state-error-primary: #f25a5a;
  --dsw-alias-brand-primary: #f9fafb;
}
body { background: var(--dsw-alias-bg-base); }
`

const DAY = Date.UTC(2026, 9, 22, 6, 0)

function graph(id: string, executor: Executor, status: GraphStatus, at: number, node: Partial<NodeSnapshot>): GraphSnapshot {
  return {
    formatVersion: 1,
    graph: { formatVersion: 1, id, label: id.startsWith('native-check-') ? `${executor} 原生连接测试` : 'Solar coordinated collaboration', cwd: '/tmp/work', maxParallel: 1, nodes: [{ id: 'n', executor, prompt: 'p' }] },
    status,
    revision: 1,
    createdAt: at,
    updatedAt: at + 5000,
    nodes: [{ id: 'n', status: status === 'completed' ? 'succeeded' : status === 'running' ? 'running' : 'failed', attempt: 1, ...node }],
  }
}

/** The states observed on the author's Mac on 2026-10-22, plus an optional scheduler outage or running task. */
function observedStatus(params: URLSearchParams): NativeUiStatus {
  const graphs: GraphSnapshot[] = [
    graph('native-check-codex', 'codex', 'completed', DAY - 3 * 86400000, { output: 'SOLAR_CODEX_OK' }),
    graph('native-check-claude', 'claude-code', 'failed', DAY - 86400000, { error: { code: 'COMMAND_FAILED', message: 'Claude native turn failed: API Error: Connection refused — a firewall or proxy may be blocking it (ConnectionRefused)' } }),
    graph('collab-e2e', 'codex', 'completed', DAY, { output: 'SOLAR_E2E_OK' }),
  ]
  if (params.get('running') === '1') graphs.push(graph('collab-running', 'codex', 'running', DAY + 60000, {}))
  return {
    checkedAt: new Date(DAY + 120000).toISOString(),
    resident: params.get('resident') === 'down'
      ? { available: false, message: 'Resident is not reachable' }
      : { available: true, message: 'Resident 已连接，任务查询正常。' },
    tools: ['solar_resident', 'solar_delegate', 'solar_coordinate', 'solar_wait'].map(name => ({ name, available: true })),
    providers: [
      { name: 'codex', label: '官方 Codex 子智能体', available: true },
      { name: 'claude-code', label: '官方 Claude Code 子智能体', available: true },
    ],
    graphs,
  }
}

const ok = <T,>(value: T): RemoteResult<T> => ({ ok: true, value }) as RemoteResult<T>

/** Settings panel against a fixture-only remote; tests and controls never leave the page. */
export function SettingsFixture(): ReactElement {
  const params = new URLSearchParams(window.location.search)
  const store = new RemoteAccessStore()
  const status = observedStatus(params)
  store.setApi({
    status: async () => ok(status),
    inspect: async input => ok(status.graphs.find(item => item.graph.id === input.graphId) ?? status.graphs[0]!),
    control: async input => ok(status.graphs.find(item => item.graph.id === input.graphId) ?? status.graphs[0]!),
    test: async input => ok(graph(`native-check-${input.commandId}`, input.executor, 'running', Date.now(), {})),
  }, {} as StudioUiApi)
  return createElement('div', { style: { padding: 24, minWidth: 0 } }, [
    createElement('style', { key: 'theme' }, DARK_THEME),
    createElement(NativeCollaborationPanel, { key: 'panel', remoteStore: store }),
  ])
}
