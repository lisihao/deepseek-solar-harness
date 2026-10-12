/** Node-local file tools restricted to a sealed TaskGraph workspace policy. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { localIpcAddress, localIpcUsesFilesystem } from '@deepseek-ai/dsh-home-paths'
import { LocalJsonRpcRequestServer } from '@deepseek-ai/dsh-sdk-protocol'
import type { PhysicalOperatorGovernedWorkspacePolicy, PhysicalOperatorModelToolBridgeV1 } from '@deepseek-ai/dsh-physical-operator'

class WorkspaceToolDenied extends Error {
  constructor(message: string) { super(`WORKSPACE_TOOL_DENIED: ${message}`) }
}

interface Binding {
  readonly fingerprint: string
  readonly workspace: string
  readonly read: readonly string[]
  readonly write: readonly string[]
  readonly forbidden: readonly string[]
  readonly limits: PhysicalOperatorGovernedWorkspacePolicy['limits']
  readonly controller: AbortController
  readonly signal: AbortSignal
  readonly tools: PhysicalOperatorModelToolBridgeV1['tools']
  readonly receipts: Map<string, { readonly hash: string; readonly result: Promise<unknown>; readonly unknown?: boolean }>
  active: boolean
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new WorkspaceToolDenied('workspace tool request must be an object')
  return value as Record<string, unknown>
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new WorkspaceToolDenied(`${label} must be a non-empty string`)
  return value
}

function contained(parent: string, path: string): boolean {
  const suffix = relative(parent, path)
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
}

function scopePath(scope: string, source: string, workspace: string): string {
  let value = scope.replace(/\/\*\*$/u, '')
  if (value === '**') value = '.'
  if (/[\*?\[\]{}]/u.test(value)) throw new WorkspaceToolDenied(`workspace scope requires an exact path or trailing /**: ${scope}`)
  const sourcePath = resolve(source, value)
  if (!contained(source, sourcePath)) throw new WorkspaceToolDenied(`workspace scope exceeds source workspace: ${scope}`)
  return resolve(workspace, relative(source, sourcePath))
}

function permitted(binding: Binding, path: string, write: boolean): boolean {
  if (!contained(binding.workspace, path)) return false
  if (relative(binding.workspace, path).split(sep).includes('.git')) return false
  if (binding.forbidden.some(root => contained(root, path))) return false
  return (write ? binding.write : binding.read).some(root => contained(root, path))
}

function bounded(binding: Binding, result: unknown): unknown {
  if (Buffer.byteLength(JSON.stringify(result)) > binding.limits.maxOutputBytes) throw new WorkspaceToolDenied('workspace tool output exceeds maxOutputBytes')
  return result
}

async function guardedPath(binding: Binding, requested: string, write: boolean): Promise<string> {
  binding.signal.throwIfAborted()
  if (isAbsolute(requested) || requested.split(/[\\/]/u).includes('..') || requested.includes('\0')) {
    throw new WorkspaceToolDenied('workspace tool path must be relative without parent traversal')
  }
  const path = resolve(binding.workspace, requested)
  if (!permitted(binding, path, write)) throw new WorkspaceToolDenied('workspace tool path is outside approved scopes')
  const suffix = relative(binding.workspace, path)
  let current = binding.workspace
  for (const component of suffix.split(sep).filter(Boolean)) {
    current = join(current, component)
    const info = await lstat(current).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
    if (info?.isSymbolicLink()) throw new WorkspaceToolDenied('workspace tool paths must not traverse symbolic links')
  }
  binding.signal.throwIfAborted()
  return path
}

async function readText(binding: Binding, path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (!(await handle.stat()).isFile()) throw new WorkspaceToolDenied('workspace read requires a regular file')
    const bytes = Buffer.alloc(binding.limits.maxFileBytes + 1)
    let offset = 0
    while (offset < bytes.length) {
      binding.signal.throwIfAborted()
      const result = await handle.read(bytes, offset, bytes.length - offset, null)
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    if (offset > binding.limits.maxFileBytes) throw new WorkspaceToolDenied('workspace file exceeds maxFileBytes')
    if (bytes.subarray(0, offset).includes(0)) throw new WorkspaceToolDenied('workspace read accepts UTF-8 text files only')
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset))
  } finally {
    await handle.close()
  }
}

async function writeText(binding: Binding, requested: string, content: string): Promise<unknown> {
  const outcome = bounded(binding, { path: requested, writtenBytes: Buffer.byteLength(content) })
  if (Buffer.byteLength(content) > binding.limits.maxFileBytes) throw new WorkspaceToolDenied('workspace write exceeds maxFileBytes')
  const path = await guardedPath(binding, requested, true)
  const missing: string[] = []
  let parent = dirname(path)
  for (;;) {
    const info = await lstat(parent).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
    if (info !== undefined) {
      if (!info.isDirectory()) throw new WorkspaceToolDenied('workspace write parent must be a directory')
      break
    }
    if (!permitted(binding, parent, true)) throw new WorkspaceToolDenied('creating a parent directory exceeds approved write scopes')
    missing.push(parent)
    parent = dirname(parent)
  }
  for (const directory of missing.reverse()) {
    binding.signal.throwIfAborted()
    await mkdir(directory)
  }
  await guardedPath(binding, requested, true)
  const previous = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (previous !== undefined && !previous.isFile()) throw new WorkspaceToolDenied('workspace write requires a regular file or an absent path')
  const temporary = join(dirname(path), `.dsh-write-${randomUUID()}`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    if (previous !== undefined) await handle.chmod(previous.mode & 0o777)
    await handle.writeFile(content, { encoding: 'utf8', signal: binding.signal })
    await handle.sync()
  } catch (error) {
    await handle.close()
    await unlink(temporary)
    throw error
  }
  await handle.close()
  try {
    await guardedPath(binding, requested, true)
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary)
    throw error
  }
  return outcome
}

async function execute(binding: Binding, args: Record<string, unknown>): Promise<unknown> {
  if (Object.keys(args).some(key => !['operation', 'path', 'content', 'query'].includes(key))) throw new WorkspaceToolDenied('unsupported workspace tool argument')
  const operation = text(args.operation, 'operation')
  const requested = text(args.path, 'path')
  const writes = operation === 'write' || operation === 'remove'
  if (!['read', 'list', 'search', 'write', 'remove'].includes(operation)) throw new WorkspaceToolDenied('workspace tools do not authorize command or network execution')
  if (!binding.active) throw new WorkspaceToolDenied('workspace binding was released')
  const path = await guardedPath(binding, requested, writes)
  switch (operation) {
    case 'read': return bounded(binding, { path: requested, content: await readText(binding, path) })
    case 'write': {
      if (typeof args.content !== 'string') throw new WorkspaceToolDenied('write content must be a string')
      return bounded(binding, await writeText(binding, requested, args.content))
    }
    case 'remove': {
      const outcome = bounded(binding, { path: requested, removed: true })
      if (!(await lstat(path)).isFile()) throw new WorkspaceToolDenied('workspace remove accepts regular files only')
      binding.signal.throwIfAborted()
      await unlink(path)
      return outcome
    }
    case 'list': {
      const entries = (await readdir(path, { withFileTypes: true })).filter((entry) => {
        return !entry.isSymbolicLink() && permitted(binding, join(path, entry.name), false)
      }).sort((a, b) => a.name.localeCompare(b.name)).map(entry => ({ name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file' }))
      return bounded(binding, { path: requested, entries })
    }
    case 'search': {
      const query = text(args.query, 'query')
      const queue = [path]
      const matches: Array<{ path: string; line: number; text: string }> = []
      let visited = 0
      for (const current of queue) {
        binding.signal.throwIfAborted()
        if (++visited > binding.limits.maxSearchFiles) throw new WorkspaceToolDenied('workspace search exceeds maxSearchFiles')
        const relativePath = relative(binding.workspace, current) || '.'
        await guardedPath(binding, relativePath, false)
        const info = await lstat(current)
        if (info.isDirectory()) {
          for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            const child = join(current, entry.name)
            if (!entry.isSymbolicLink() && permitted(binding, child, false)) queue.push(child)
          }
        } else if (info.isFile()) {
          const content = await readText(binding, current)
          for (const [index, line] of content.split('\n').entries()) {
            if (line.includes(query)) {
              matches.push({ path: relativePath, line: index + 1, text: line })
              bounded(binding, { matches })
            }
          }
        }
      }
      return bounded(binding, { matches })
    }
  }
  throw new WorkspaceToolDenied('unsupported workspace operation')
}

/** Owner-local file executor; it exposes no shell, network, MCP, or inherited native tools. */
export class WorkspaceModelToolBridge {
  private readonly bindings = new Map<string, Binding>()
  private readonly endpoint: string
  private readonly journalPath: string
  private journalTail: Promise<void> = Promise.resolve()
  private readonly server: LocalJsonRpcRequestServer

  /** @param root - private daemon-owned directory reserved for this command's bridge. */
  constructor(private readonly root: string) {
    this.journalPath = join(root, 'tool-receipts.jsonl')
    this.endpoint = localIpcAddress(root, 'workspace')
    const endpoint = { path: this.endpoint, ...localIpcUsesFilesystem() ? { directory: dirname(this.endpoint) } : {} }
    this.server = new LocalJsonRpcRequestServer(endpoint, async (method, params) => {
      const raw = object(params)
      const binding = this.bindings.get(text(raw.session_id, 'session_id'))
      if (binding === undefined || !binding.active) throw new WorkspaceToolDenied('workspace tool session is not attached')
      if (method === 'tool.describe') return { version: 1, sessionId: raw.session_id, tools: binding.tools.map(tool => tool.name) }
      if (method !== 'tool.call') throw new WorkspaceToolDenied('unsupported workspace tool method')
      const commandId = text(raw.command_id, 'command_id')
      const args = object(raw.arguments)
      const hash = createHash('sha256').update(JSON.stringify({ tool: raw.tool, args })).digest('hex')
      const existing = binding.receipts.get(commandId)
      if (existing !== undefined) {
        if (existing.hash !== hash) throw new WorkspaceToolDenied('workspace tool command identity conflicts with its prior arguments')
        return existing.result
      }
      if (binding.receipts.size >= binding.limits.maxToolCalls) throw new WorkspaceToolDenied('workspace tool exceeds maxToolCalls')
      const result = Promise.resolve().then(async () => {
        try {
          await this.record({ commandId, hash, fingerprint: binding.fingerprint, state: 'executing' })
        } catch {
          throw new Error('COMMAND_INDETERMINATE: tool admission persistence failed; inspect the existing command')
        }
        let value: unknown
        try {
          if (raw.tool !== 'workspace_files') throw new WorkspaceToolDenied('only workspace_files is authorized')
          value = await execute(binding, args)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const mayMutate = raw.tool === 'workspace_files' && (args.operation === 'write' || args.operation === 'remove')
          if (mayMutate && !(error instanceof WorkspaceToolDenied)) {
            throw new Error('COMMAND_INDETERMINATE: file mutation outcome is unknown; inspect the existing command')
          }
          const denial = error instanceof WorkspaceToolDenied ? error : new WorkspaceToolDenied(message)
          try {
            await this.record({ commandId, hash, fingerprint: binding.fingerprint, state: 'settled', error: denial.message })
          } catch {
            throw new Error('COMMAND_INDETERMINATE: tool failure persistence failed; inspect the existing command')
          }
          throw denial
        }
        try {
          await this.record({ commandId, hash, fingerprint: binding.fingerprint, state: 'settled', value })
        } catch {
          throw new Error('COMMAND_INDETERMINATE: file effect succeeded without a durable result; inspect the existing command')
        }
        return value
      })
      binding.receipts.set(commandId, { hash, result })
      return result
    })
  }

  /**
   * Bind exact graph scopes after relocating source-relative paths to the actual execution directory.
   * @param commandId - durable command identity for this private tool session.
   * @param request - actual host workspace and sealed caller-owned policy.
   * @param signal - execution cancellation.
   * @returns descriptor and a release operation that waits for all accepted file effects to settle.
   */
  async bind(
    commandId: string, request: { readonly workspace: string; readonly policy: PhysicalOperatorGovernedWorkspacePolicy },
    signal: AbortSignal,
  ): Promise<{
    readonly descriptor: PhysicalOperatorModelToolBridgeV1
    release(): Promise<void>
  }> {
    const workspace = await realpath(request.workspace)
    const policy = request.policy
    for (const [name, limit] of Object.entries(policy.limits)) {
      if (!Number.isSafeInteger(limit) || limit < (name === 'maxToolCalls' ? 0 : 1)) throw new WorkspaceToolDenied('workspace tool limits must be valid safe integers')
    }
    const source = resolve(policy.sourceWorkspace)
    const operations = [...policy.readScopes.length === 0 ? [] : ['read', 'list', 'search'], ...policy.writeScopes.length === 0 ? [] : ['write', 'remove']]
    const tools: PhysicalOperatorModelToolBridgeV1['tools'] = [{
      name: 'workspace_files', description: 'Read, list, search, write, or remove UTF-8 files within this task\'s approved workspace scopes. Commands and network access are unavailable.',
      inputSchema: { type: 'object', required: ['operation', 'path'], additionalProperties: false, properties: {
        operation: { type: 'string', enum: operations }, path: { type: 'string', description: 'Workspace-relative path without .. or symbolic links.' },
        content: { type: 'string' }, query: { type: 'string' },
      } },
    }]
    const controller = new AbortController()
    const binding: Binding = {
      fingerprint: createHash('sha256').update(JSON.stringify({ workspace, policy })).digest('hex'),
      workspace, read: policy.readScopes.map(scope => scopePath(scope, source, workspace)),
      write: policy.writeScopes.map(scope => scopePath(scope, source, workspace)),
      forbidden: policy.forbiddenScopes.map(scope => scopePath(scope, source, workspace)), limits: policy.limits,
      controller, signal: AbortSignal.any([signal, controller.signal]), tools, receipts: new Map(), active: true,
    }
    const sessionId = `workspace:${commandId}`
    if (this.bindings.has(sessionId)) throw new WorkspaceToolDenied('workspace tool session is already attached')
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const journal = await readFile(this.journalPath, 'utf8').catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw error
    })
    for (const line of journal.split('\n').filter(Boolean)) {
      const receipt = object(JSON.parse(line))
      if (typeof receipt.commandId !== 'string' || typeof receipt.hash !== 'string' || receipt.fingerprint !== binding.fingerprint
        || !['executing', 'settled'].includes(String(receipt.state))) {
        throw new Error('COMMAND_INDETERMINATE: workspace receipt journal does not match its sealed policy')
      }
      const result = receipt.state !== 'settled'
        ? Promise.reject(new Error('COMMAND_INDETERMINATE: prior workspace tool outcome is unknown; inspect it before retrying'))
        : typeof receipt.error === 'string' ? Promise.reject(new WorkspaceToolDenied(receipt.error.replace(/^WORKSPACE_TOOL_DENIED: /u, ''))) : Promise.resolve(receipt.value)
      void result.catch(() => { /* Receipt errors are delivered only when that exact command is requested again. */ })
      binding.receipts.set(receipt.commandId, { hash: receipt.hash, result, unknown: receipt.state !== 'settled' })
    }
    if ([...binding.receipts.values()].some(receipt => receipt.unknown)) {
      throw new Error('COMMAND_INDETERMINATE: prior workspace tool outcome is unknown; reconcile it before binding a new turn')
    }
    await this.server.start()
    this.bindings.set(sessionId, binding)
    return {
      descriptor: { version: 1, socketPath: this.endpoint, sessionId, tools },
      release: async () => {
        binding.active = false
        binding.controller.abort(new Error('workspace binding was released'))
        this.bindings.delete(sessionId)
        await Promise.allSettled([...binding.receipts.values()].map(receipt => receipt.result))
      },
    }
  }

  private record(value: Record<string, unknown>): Promise<void> {
    this.journalTail = this.journalTail.then(async () => {
      const handle = await open(this.journalPath, 'a', 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(value)}\n`)
        await handle.sync()
      } finally { await handle.close() }
    })
    return this.journalTail
  }

  /** Stop accepting calls, settle file effects, and remove only the bridge-owned socket. */
  async dispose(): Promise<void> {
    for (const binding of this.bindings.values()) {
      binding.active = false
      binding.controller.abort(new Error('workspace bridge was disposed'))
    }
    await Promise.allSettled([...this.bindings.values()].flatMap(binding => [...binding.receipts.values()].map(receipt => receipt.result)))
    this.bindings.clear()
    await this.server.dispose()
  }
}
