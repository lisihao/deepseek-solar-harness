import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { requestLocalJsonRpc } from '@deepseek-ai/dsh-sdk-protocol'
import type { PhysicalOperatorGovernedWorkspacePolicy } from '@deepseek-ai/dsh-physical-operator'
import { WorkspaceModelToolBridge } from '../src/workspace-model-tool-bridge.ts'

const limits = { maxToolCalls: 30, maxFileBytes: 1024, maxOutputBytes: 4096, maxSearchFiles: 20 }

async function fixture(overrides: Partial<PhysicalOperatorGovernedWorkspacePolicy> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-tools-'))
  const source = join(root, 'source')
  const workspace = join(root, 'isolated')
  await mkdir(source)
  await mkdir(workspace)
  await mkdir(join(workspace, 'allowed'))
  await mkdir(join(workspace, '.git'))
  await writeFile(join(source, 'original.txt'), 'source remains intact')
  await writeFile(join(workspace, 'allowed', 'readme.txt'), 'isolated evidence\nsecond line')
  await writeFile(join(workspace, 'secret.txt'), 'not approved')
  const bridge = new WorkspaceModelToolBridge(join(root, 'runtime'))
  const controller = new AbortController()
  const policy: PhysicalOperatorGovernedWorkspacePolicy = {
    version: 1, sourceWorkspace: source, readScopes: [join(source, 'allowed')], writeScopes: [join(source, 'allowed')],
    forbiddenScopes: ['allowed/private'], limits, ...overrides,
  }
  const binding = await bridge.bind('command', { workspace, policy }, controller.signal)
  let sequence = 0
  const call = (args: Record<string, unknown>, commandId = `tool-${++sequence}`, tool = 'workspace_files') => requestLocalJsonRpc(
    binding.descriptor.socketPath, 'tool.call', { session_id: binding.descriptor.sessionId, command_id: commandId, tool, arguments: args },
    new AbortController().signal, () => new Error('aborted'),
  )
  return {
    root, source, workspace, policy, bridge, binding, call, controller,
    close: async () => { await binding.release(); await bridge.dispose(); await rm(root, { recursive: true, force: true }) },
  }
}

describe('governed workspace file tool execution', () => {
  it('relocates absolute source scopes to the actual isolated directory and performs real read, search, atomic write and remove', async () => {
    const f = await fixture()
    try {
      await expect(f.call({ operation: 'read', path: 'allowed/readme.txt' })).resolves.toMatchObject({ content: 'isolated evidence\nsecond line' })
      await expect(f.call({ operation: 'list', path: 'allowed' })).resolves.toMatchObject({ entries: [{ name: 'readme.txt', kind: 'file' }] })
      await expect(f.call({ operation: 'search', path: 'allowed', query: 'evidence' })).resolves.toMatchObject({ matches: [{ path: 'allowed/readme.txt', line: 1, text: 'isolated evidence' }] })
      await f.call({ operation: 'write', path: 'allowed/new/sub.txt', content: 'new file' })
      expect(await readFile(join(f.workspace, 'allowed', 'new', 'sub.txt'), 'utf8')).toBe('new file')
      await f.call({ operation: 'write', path: 'allowed/new/sub.txt', content: 'replacement' })
      expect(await readFile(join(f.workspace, 'allowed', 'new', 'sub.txt'), 'utf8')).toBe('replacement')
      await f.call({ operation: 'remove', path: 'allowed/new/sub.txt' })
      await expect(readFile(join(f.workspace, 'allowed', 'new', 'sub.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(join(f.source, 'original.txt'), 'utf8')).toBe('source remains intact')
    } finally { await f.close() }
  })

  it('rejects undeclared paths, traversal, forbidden scopes, Git metadata, command and network effects at the executor', async () => {
    const f = await fixture({ readScopes: ['.'], writeScopes: ['allowed'] })
    try {
      await mkdir(join(f.workspace, 'allowed', 'private'))
      await writeFile(join(f.workspace, 'allowed', 'private', 'hidden'), 'private')
      for (const args of [
        { operation: 'write', path: 'secret.txt', content: 'forbidden' },
        { operation: 'read', path: '../source/original.txt' },
        { operation: 'read', path: join(f.source, 'original.txt') },
        { operation: 'read', path: 'allowed/private/hidden' },
        { operation: 'read', path: '.git/config' },
        { operation: 'execute', path: 'allowed', command: 'touch forbidden' },
        { operation: 'network', path: 'allowed', url: 'https://example.com' },
      ]) await expect(f.call(args)).rejects.toThrow()
      await expect(f.call({ operation: 'write', path: 'allowed/not-created', content: 'forbidden' }, 'shell', 'shell')).rejects.toThrow('only workspace_files')
      expect(await readFile(join(f.workspace, 'secret.txt'), 'utf8')).toBe('not approved')
      await expect(readFile(join(f.workspace, 'allowed', 'not-created'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await f.close() }
  })

  it('rejects symbolic links to an outside file or directory before reading or writing', async () => {
    const f = await fixture()
    try {
      await symlink(join(f.source, 'original.txt'), join(f.workspace, 'allowed', 'link-file'))
      await symlink(f.source, join(f.workspace, 'allowed', 'link-dir'), process.platform === 'win32' ? 'junction' : 'dir')
      await expect(f.call({ operation: 'read', path: 'allowed/link-file' })).rejects.toThrow('symbolic links')
      await expect(f.call({ operation: 'write', path: 'allowed/link-dir/original.txt', content: 'unauthorized' })).rejects.toThrow('symbolic links')
      await expect(f.call({ operation: 'remove', path: 'allowed/link-file' })).rejects.toThrow('symbolic links')
      expect(await readFile(join(f.source, 'original.txt'), 'utf8')).toBe('source remains intact')
    } finally { await f.close() }
  })

  it('denies mutations for a read-only policy while reads remain available', async () => {
    const f = await fixture({ writeScopes: [] })
    try {
      await expect(f.call({ operation: 'read', path: 'allowed/readme.txt' })).resolves.toMatchObject({ content: 'isolated evidence\nsecond line' })
      await expect(f.call({ operation: 'write', path: 'allowed/readme.txt', content: 'no' })).rejects.toThrow('approved scopes')
      await expect(f.call({ operation: 'remove', path: 'allowed/readme.txt' })).rejects.toThrow('approved scopes')
      expect(f.binding.descriptor.tools[0]?.inputSchema).toMatchObject({ properties: { operation: { enum: ['read', 'list', 'search'] } } })
    } finally { await f.close() }
  })

  it('settles one command once and rejects changed arguments or calls beyond the configured budget', async () => {
    const f = await fixture({ limits: { ...limits, maxToolCalls: 1 } })
    try {
      const args = { operation: 'write', path: 'allowed/result.txt', content: 'first' }
      await f.call(args, 'same')
      await writeFile(join(f.workspace, 'allowed', 'result.txt'), 'external edit')
      await f.call(args, 'same')
      expect(await readFile(join(f.workspace, 'allowed', 'result.txt'), 'utf8')).toBe('external edit')
      await expect(f.call({ ...args, content: 'changed' }, 'same')).rejects.toThrow('conflicts')
      await expect(f.call(args, 'different')).rejects.toThrow('maxToolCalls')
    } finally { await f.close() }
  })

  it('enforces file and output byte limits and detaches the released binding', async () => {
    const f = await fixture({ limits: { ...limits, maxFileBytes: 8 } })
    try {
      await expect(f.call({ operation: 'read', path: 'allowed/readme.txt' })).rejects.toThrow('maxFileBytes')
      await expect(f.call({ operation: 'write', path: 'allowed/large.txt', content: '012345678' })).rejects.toThrow('maxFileBytes')
      await f.binding.release()
      await expect(f.call({ operation: 'read', path: 'allowed/readme.txt' })).rejects.toThrow('not attached')
    } finally { await f.close() }
  })


  it('checks output limits before mutation and permits a zero-call budget without exposing execution authority', async () => {
    const f = await fixture({ limits: { ...limits, maxOutputBytes: 10 } })
    try {
      await expect(f.call({ operation: 'write', path: 'allowed/never-created.txt', content: 'ok' })).rejects.toThrow('maxOutputBytes')
      await expect(readFile(join(f.workspace, 'allowed', 'never-created.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(f.call({ operation: 'remove', path: 'allowed/readme.txt' })).rejects.toThrow('maxOutputBytes')
      expect(await readFile(join(f.workspace, 'allowed', 'readme.txt'), 'utf8')).toContain('isolated evidence')
    } finally { await f.close() }
    const zero = await fixture({ limits: { ...limits, maxToolCalls: 0 } })
    try { await expect(zero.call({ operation: 'read', path: 'allowed/readme.txt' })).rejects.toThrow('maxToolCalls') }
    finally { await zero.close() }
  })

  it('reloads durable settled receipts without repeating a file effect after bridge restart', async () => {
    const f = await fixture({ limits: { ...limits, maxToolCalls: 1 } })
    const args = { operation: 'write', path: 'allowed/result.txt', content: 'first' }
    await f.call(args, 'persisted')
    await f.binding.release()
    await f.bridge.dispose()
    await writeFile(join(f.workspace, 'allowed', 'result.txt'), 'manually changed')
    const restarted = new WorkspaceModelToolBridge(join(f.root, 'runtime'))
    const binding = await restarted.bind('command', { workspace: f.workspace, policy: f.policy }, new AbortController().signal)
    try {
      await requestLocalJsonRpc(binding.descriptor.socketPath, 'tool.call', { session_id: binding.descriptor.sessionId, command_id: 'persisted', tool: 'workspace_files', arguments: args },
        new AbortController().signal, () => new Error('aborted'))
      expect(await readFile(join(f.workspace, 'allowed', 'result.txt'), 'utf8')).toBe('manually changed')
    } finally { await binding.release(); await restarted.dispose(); await f.close() }
  })

  it('refuses to bind any new call when a prior durable executing receipt has no settled outcome', async () => {
    const f = await fixture()
    await f.call({ operation: 'write', path: 'allowed/result.txt', content: 'effect happened' }, 'uncertain')
    await f.binding.release()
    await f.bridge.dispose()
    const journalPath = join(f.root, 'runtime', 'tool-receipts.jsonl')
    const first = (await readFile(journalPath, 'utf8')).split('\n')[0]!
    await writeFile(journalPath, `${first}\n`)
    const restarted = new WorkspaceModelToolBridge(join(f.root, 'runtime'))
    try {
      await expect(restarted.bind('command', { workspace: f.workspace, policy: f.policy }, new AbortController().signal)).rejects.toThrow('COMMAND_INDETERMINATE')
      expect(await readFile(join(f.workspace, 'allowed', 'result.txt'), 'utf8')).toBe('effect happened')
    } finally { await restarted.dispose(); await f.close() }
  })
  it('rejects a scope outside the original source root before publishing an endpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-invalid-workspace-tools-'))
    const bridge = new WorkspaceModelToolBridge(join(root, 'runtime'))
    try {
      await expect(bridge.bind('command', { workspace: root, policy: {
        version: 1, sourceWorkspace: root, readScopes: ['../other'], writeScopes: [], forbiddenScopes: [], limits,
      } }, new AbortController().signal)).rejects.toThrow('exceeds source workspace')
    } finally { await bridge.dispose(); await rm(root, { recursive: true, force: true }) }
  })
})
