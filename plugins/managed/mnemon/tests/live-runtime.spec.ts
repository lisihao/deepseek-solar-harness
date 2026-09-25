import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import type { HostAgent, HostAgentsService, HostWorkspaceRegistry } from '../src/contracts.ts'
import { createRuntimeGraph, LiveMnemonRuntime } from '../src/live-runtime.ts'

const directories: string[] = []

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `dsh-mnemon-${label}-`))
  directories.push(directory)
  return directory
}

function agent(id: string, cwd: string): HostAgent {
  return {
    id,
    status: 'idle',
    session: { header: { cwd }, events: [] },
    ctx: { on: vi.fn(), effect: vi.fn() },
    followup: vi.fn(),
    steer: vi.fn(),
    inject: vi.fn(),
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('LiveMnemonRuntime workspace routing', () => {
  it('separates the inspected workspace from the current session execution workspace', () => {
    const workspaceOne = temporaryDirectory('workspace-one')
    const workspaceTwo = temporaryDirectory('workspace-two')
    const initialRoot = temporaryDirectory('initial')
    const workspaces = [
      { id: 'workspace-1', title: 'Workspace One', path: workspaceOne },
      { id: 'workspace-2', title: 'Workspace Two', path: workspaceTwo },
    ]
    const registry = {
      get: (id: string) => workspaces.find(workspace => workspace.id === id),
      list: () => workspaces,
    } satisfies HostWorkspaceRegistry
    const sessionAgent = agent('session-1', workspaceOne)
    const agents = {
      get: (id: string) => id === sessionAgent.id ? sessionAgent : undefined,
      roots: () => [sessionAgent],
    } satisfies HostAgentsService
    const config = resolveConfig({ storageScope: 'workspace', cliPath: '/fake/mnemon' })
    const runtime = new LiveMnemonRuntime(createRuntimeGraph(config, initialRoot), registry, agents)

    expect(runtime.forAgent(sessionAgent).runner.effectiveDataDir()).toBe(join(workspaceOne, '.mnemon'))
    expect(runtime.forWorkspaceId('workspace-2').runner.effectiveDataDir()).toBe(join(workspaceTwo, '.mnemon'))
    expect(runtime.route({ workspaceId: 'workspace-2', sessionId: 'session-1' })).toMatchObject({
      selectedRoot: join(workspaceTwo, '.mnemon'),
      effectiveRoot: join(workspaceOne, '.mnemon'),
      aligned: false,
      selectedWorkspace: { id: 'workspace-2' },
      effectiveWorkspace: { id: 'workspace-1' },
    })
    expect(runtime.route({ workspaceId: 'workspace-1', sessionId: 'session-1' }).aligned).toBe(true)
  })

  it('rejects arbitrary workspace identifiers at the Host boundary', () => {
    const workspace = temporaryDirectory('workspace')
    const config = resolveConfig({ storageScope: 'workspace', cliPath: '/fake/mnemon' })
    const registry = { get: vi.fn(), list: vi.fn(() => []) } satisfies HostWorkspaceRegistry
    const runtime = new LiveMnemonRuntime(createRuntimeGraph(config, workspace), registry, { get: vi.fn(), roots: vi.fn(() => []) })

    expect(() => runtime.forWorkspaceId('../../private')).toThrow('selected DSH workspace is unavailable')
    expect(registry.get).toHaveBeenCalledWith('../../private')
  })

  it('keeps global and custom storage on their configured singleton root', () => {
    const workspace = temporaryDirectory('workspace')
    const globalRuntime = new LiveMnemonRuntime(createRuntimeGraph(resolveConfig({ storageScope: 'global', cliPath: '/fake/mnemon' }), workspace))
    const customRoot = temporaryDirectory('custom')
    const customRuntime = new LiveMnemonRuntime(createRuntimeGraph(resolveConfig({ storageScope: 'custom', dataDir: customRoot, cliPath: '/fake/mnemon' }), workspace))
    const sessionAgent = agent('session-1', temporaryDirectory('other-workspace'))

    expect(globalRuntime.forAgent(sessionAgent)).toBe(globalRuntime.snapshot())
    expect(customRuntime.forAgent(sessionAgent)).toBe(customRuntime.snapshot())
    expect(customRuntime.route({ sessionId: 'session-1' })).toMatchObject({ selectedRoot: customRoot, effectiveRoot: customRoot, aligned: true })
  })

  it('routes Headless workspace storage by Agent cwd without a Web workspace registry', () => {
    const initialRoot = temporaryDirectory('headless-initial')
    const workspace = temporaryDirectory('headless-workspace')
    const sessionAgent = agent('headless-session', workspace)
    const agents = {
      get: (id: string) => id === sessionAgent.id ? sessionAgent : undefined,
      roots: () => [sessionAgent],
    } satisfies HostAgentsService
    const runtime = new LiveMnemonRuntime(
      createRuntimeGraph(resolveConfig({ storageScope: 'workspace', cliPath: '/fake/mnemon' }), initialRoot),
      undefined,
      agents,
    )

    expect(runtime.forAgent(sessionAgent).runner.effectiveDataDir()).toBe(join(workspace, '.mnemon'))
    expect(runtime.route({ sessionId: sessionAgent.id })).toMatchObject({
      selectedRoot: join(workspace, '.mnemon'),
      effectiveRoot: join(workspace, '.mnemon'),
      aligned: true,
    })
    expect(() => runtime.forWorkspaceId('web-only-selection')).toThrow('selected DSH workspace is unavailable')
  })
})
