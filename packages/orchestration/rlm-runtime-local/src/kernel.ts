/** Persistent TypeScript REPL kernel isolated in a killable Worker lifecycle. */

import { Worker } from 'node:worker_threads'
import type {
  RlmChildHandleV1,
  RlmCompactRunOutcomeV1,
  RlmJsonValue,
} from '@deepseek-ai/dsh-rlm-runtime'
import { analyzeTypeScriptCell, type KernelDeclaration, type KernelDeclarationKind } from './namespace.ts'

/** Prime v0.8-compatible aggregate ceiling for one namespace snapshot. */
export const RLM_SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024
/** Prime v0.8-compatible ceiling for one snapshotted namespace binding. */
export const RLM_SNAPSHOT_MAX_VARIABLE_BYTES = 16 * 1024 * 1024

/** Byte ceilings applied independently and then to the aggregate snapshot. */
export interface KernelSnapshotLimits {
  readonly maxBytes: number
  readonly maxVariableBytes: number
}

/** Best-effort durable representation of one lexical declaration. */
export interface PersistedVariable {
  readonly name: string
  readonly declaration: KernelDeclarationKind
  readonly valueBase64?: string
  readonly source?: string
  readonly sourceId?: string
  readonly sourceKind?: KernelDeclaration['sourceKind']
  readonly error?: string
}

/** Host-owned capabilities injected into one programmable kernel. */
export interface KernelHooks {
  /** The host validates Prime's runtime option surface; the Worker boundary is untrusted. */
  spawn(task: string, options?: unknown): Promise<RlmChildHandleV1>
  listChildren(): Promise<unknown>
  deleteChild(child: unknown): Promise<void>
  sendMessage(text: string, options: { readonly receiverRole: 'parent' | 'child' | 'sibling'; readonly receiverName?: string; readonly mode?: 'auto' | 'steer' | 'follow_up'; readonly artifactRefs?: readonly string[] }): Promise<unknown>
  broadcastMessage(text: string, options?: { readonly mode?: 'auto' | 'steer' | 'follow_up'; readonly artifactRefs?: readonly string[] }): Promise<unknown>
  listAgents(): Promise<unknown>
  readMessages(after?: number, limit?: number): Promise<unknown>
  harness(method: string, params: Readonly<Record<string, RlmJsonValue>>): Promise<RlmJsonValue>
  skill(method: 'skills.list' | 'skills.call', params: Readonly<Record<string, RlmJsonValue>>): Promise<RlmJsonValue>
  setGoal(objective: string, options?: { readonly status?: 'active' | 'complete' | 'blocked'; readonly continuationBudget?: number }): Promise<unknown>
  getGoal(): Promise<unknown>
  completeGoal(): Promise<unknown>
  createHeartbeat(instruction: string, options?: { readonly interval?: string; readonly label?: string; readonly deliveryMode?: 'steer' | 'follow_up' }): Promise<unknown>
  listHeartbeats(includeInactive?: boolean): Promise<unknown>
  updateHeartbeat(heartbeatId: string, options: { readonly instruction?: string; readonly interval?: string; readonly label?: string | null; readonly deliveryMode?: 'steer' | 'follow_up'; readonly status?: 'pause' | 'resume' }): Promise<unknown>
  deleteHeartbeat(heartbeatId: string): Promise<unknown>
  compactStatus(): Promise<RlmJsonValue>
  compactRun(options?: { readonly instructions?: string }): Promise<RlmCompactRunOutcomeV1>
}

/** Settled cell output and the next durable namespace snapshot. */
export interface KernelCellResult {
  readonly logs: readonly string[]
  readonly value?: RlmJsonValue
  readonly display: string
  readonly context?: Readonly<Record<string, RlmJsonValue>>
  readonly variables: readonly PersistedVariable[]
  readonly degradedVariables: readonly string[]
}

interface WorkerMessage {
  readonly type: string
  readonly id?: number
  readonly method?: string
  readonly args?: unknown[]
  readonly ok?: boolean
  readonly value?: unknown
  readonly error?: string
  readonly errorCode?: string
  readonly result?: KernelCellResult
}

interface PendingCell {
  readonly resolve: (value: KernelCellResult) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { PassThrough } = require('node:stream');
const { inspect, formatWithOptions } = require('node:util');
const { deserialize, serialize } = require('node:v8');
const { start } = require('node:repl');
const RESERVED = new Set(['context', 'rlm', 'agentMessage', 'agent_message', 'harness', 'skills', 'goal', 'rlmHeartbeat', 'rlm_heartbeat', 'compact', 'console']);
const declarations = new Map();
const degradedDeclarations = new Map();
const hostCalls = new Map();
let hostOrdinal = 0;
let activeLogs;
let activeExecutionId;
let activeHostError;
const input = new PassThrough();
const output = new PassThrough();
output.on('data', chunk => {
  if (activeExecutionId === undefined) return;
  const rendered = String(chunk).replace(/\u001b\[[0-9;]*m/g, '').trim();
  if (!rendered.startsWith('Uncaught')) return;
  const firstLine = rendered.split('\n', 1)[0].replace(/^Uncaught\s+/, '');
  parentPort.postMessage({
    type: 'execute-result',
    id: activeExecutionId,
    ok: false,
    error: activeHostError?.message ?? firstLine,
    ...(activeHostError?.code === undefined ? {} : { errorCode: activeHostError.code }),
  });
  activeExecutionId = undefined;
});
const server = start({ input, output, prompt: '', terminal: false, useGlobal: false });
const evaluate = code => new Promise((resolve, reject) => {
  server.eval(code, server.context, 'dsh-rlm.ts', (error, value) => error !== null ? reject(error) : resolve(value));
});
const host = (method, args) => new Promise((resolve, reject) => {
  const id = ++hostOrdinal;
  hostCalls.set(id, { resolve, reject });
  parentPort.postMessage({ type: 'host-call', id, method, args });
});
const log = (...values) => activeLogs?.push(formatWithOptions({ colors: false, depth: 5, maxArrayLength: 100 }, ...values));
Object.assign(server.context, {
  context: structuredClone(workerData.context),
  console: Object.freeze({ log, info: log, warn: log, error: log, debug: log }),
});
const rlm = Object.assign((task, options) => host('spawn', [task, options]), {
  listSubagents: () => host('listChildren', []),
  list_subagents: () => host('listChildren', []),
  deleteSubagent: child => host('deleteChild', [child]),
  delete_subagent: child => host('deleteChild', [child]),
});
const agentMessage = Object.freeze({
  send: (text, optionsOrBroadcast) => text === 'all' && typeof optionsOrBroadcast === 'string'
    ? host('broadcastMessage', [optionsOrBroadcast])
    : host('sendMessage', [text, optionsOrBroadcast]),
  broadcast: (text, options) => host('broadcastMessage', [text, options]),
  listAgents: () => host('listAgents', []),
  list_agents: () => host('listAgents', []),
  read: (after, limit) => host('readMessages', [after, limit]),
});
const harness = Object.freeze({
  list: (params = {}) => host('harness', ['harness.list', params]),
  get: params => host('harness', ['harness.get', params]),
  create: params => host('harness', ['harness.create', params]),
  update: params => host('harness', ['harness.update', params]),
  delete: params => host('harness', ['harness.delete', params]),
  planRefinement: params => host('harness', ['harness.plan_refinement', params]),
  applyRefinement: params => host('harness', ['harness.apply_refinement', params]),
  rollback: params => host('harness', ['harness.rollback', params]),
});
const managedSkill = async (method, params) => {
  try {
    return { ok: true, result: await host('skill', [method, params]) };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error instanceof Error && typeof error.code === 'string' ? error.code : 'RLM_UNAVAILABLE',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
};
const skills = Object.freeze({
  list: (params = {}) => managedSkill('skills.list', params),
  call: (name, args = {}) => managedSkill('skills.call', { alias: name, args }),
});
const goal = Object.freeze({
  create: (objective, options) => host('setGoal', [objective, options]),
  set: (objective, options) => host('setGoal', [objective, options]),
  get: () => host('getGoal', []),
  complete: () => host('completeGoal', []),
});
const rlmHeartbeat = Object.freeze({
  create: (instruction, options) => host('createHeartbeat', [instruction, options]),
  list: includeInactive => host('listHeartbeats', [includeInactive]),
  update: (heartbeatId, options) => host('updateHeartbeat', [heartbeatId, options]),
  delete: heartbeatId => host('deleteHeartbeat', [heartbeatId]),
});
const compact = Object.freeze({
  status: () => host('compactStatus', []),
  run: (options = {}) => {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      return Promise.reject(Object.assign(new Error('compact.run requires an options object'), { code: 'RLM_INVALID' }));
    }
    if (options.instructions !== undefined && typeof options.instructions !== 'string') {
      return Promise.reject(Object.assign(new Error('compact.run instructions must be a string'), { code: 'RLM_INVALID' }));
    }
    return host('compactRun', [options]);
  },
});
Object.assign(server.context, { rlm, agentMessage, agent_message: agentMessage, harness, skills, goal, rlmHeartbeat, rlm_heartbeat: rlmHeartbeat, compact });
function jsonValue(value) {
  if (value === undefined) return undefined;
  try { return JSON.parse(JSON.stringify(value)); } catch { return undefined; }
}
function contextValue(value) {
  const result = jsonValue(value);
  return result !== null && typeof result === 'object' && !Array.isArray(result) ? result : undefined;
}
function restoreDeclaration(variable) {
  return variable.declaration === 'let' || variable.declaration === 'var' ? variable.declaration : 'const';
}
function degraded(variable, error) {
  return {
    name: variable.name,
    declaration: variable.declaration,
    ...(variable.source === undefined ? {} : { source: variable.source }),
    ...(variable.sourceId === undefined ? {} : { sourceId: variable.sourceId }),
    ...(variable.sourceKind === undefined ? {} : { sourceKind: variable.sourceKind }),
    error: error instanceof Error ? error.message : String(error),
  };
}
async function restore(variables) {
  const restoredSources = new Map();
  for (const variable of variables) {
    if (variable.error !== undefined || (variable.valueBase64 === undefined && variable.source === undefined)) {
      degradedDeclarations.set(variable.name, variable);
      continue;
    }
    if (variable.valueBase64 === undefined && variable.source !== undefined) {
      const sourceId = variable.sourceId ?? ('source:' + variable.name);
      let sourceError = restoredSources.get(sourceId);
      if (!restoredSources.has(sourceId)) {
        try {
          await evaluate(variable.source);
          sourceError = undefined;
        } catch (error) {
          sourceError = error;
        }
        restoredSources.set(sourceId, sourceError);
      }
      if (sourceError !== undefined) {
        degradedDeclarations.set(variable.name, degraded(variable, sourceError));
        continue;
      }
      try {
        await evaluate(variable.name);
        declarations.set(variable.name, variable);
        degradedDeclarations.delete(variable.name);
      } catch (error) {
        degradedDeclarations.set(variable.name, degraded(variable, error));
      }
      continue;
    }
    try {
      server.context.__dshRestoreValue = deserialize(Buffer.from(variable.valueBase64, 'base64'));
      await evaluate(restoreDeclaration(variable) + ' ' + variable.name + ' = __dshRestoreValue');
      declarations.set(variable.name, variable);
      degradedDeclarations.delete(variable.name);
    } catch (error) {
      degradedDeclarations.set(variable.name, degraded(variable, error));
    } finally {
      delete server.context.__dshRestoreValue;
    }
  }
}
function sourceSnapshot(name, descriptor, value) {
  if (typeof value === 'function') {
    const functionSource = Function.prototype.toString.call(value);
    if (!functionSource.includes('[native code]') && descriptor.source?.includes(functionSource)) {
      return {
        source: 'const ' + name + ' = (' + functionSource + ');',
        sourceId: 'callable:' + name,
        sourceKind: 'declaration',
      };
    }
  }
  if (descriptor.sourceKind === 'import' && descriptor.source !== undefined) {
    return { source: descriptor.source, sourceId: descriptor.sourceId, sourceKind: 'import' };
  }
  return undefined;
}
function snapshotError(descriptor, reason) {
  return {
    name: descriptor.name,
    declaration: descriptor.declaration,
    error: reason,
  };
}
async function snapshotVariables(initialBytes) {
  const snapshots = [...degradedDeclarations.values()];
  let total = initialBytes;
  for (const [name, descriptor] of declarations) {
    try {
      const value = await evaluate(name);
      let payload;
      let payloadBytes;
      const importSource = descriptor.sourceKind === 'import' ? sourceSnapshot(name, descriptor, value) : undefined;
      if (importSource !== undefined) {
        payloadBytes = Buffer.byteLength(importSource.source, 'utf8');
        payload = importSource;
      } else {
        try {
          const serialized = serialize(value);
          payloadBytes = serialized.byteLength;
          payload = { valueBase64: serialized.toString('base64') };
        } catch (error) {
          const source = sourceSnapshot(name, descriptor, value);
          if (source === undefined) throw error;
          payloadBytes = Buffer.byteLength(source.source, 'utf8');
          payload = source;
        }
      }
      if (payloadBytes > workerData.snapshotLimits.maxVariableBytes) {
        snapshots.push(snapshotError(descriptor, 'exceeds per-variable snapshot size cap'));
        continue;
      }
      if (total + payloadBytes > workerData.snapshotLimits.maxBytes) {
        snapshots.push(snapshotError(descriptor, 'exceeds aggregate snapshot size cap'));
        continue;
      }
      total += payloadBytes;
      snapshots.push({ name, declaration: descriptor.declaration, ...payload });
    } catch (error) {
      snapshots.push(snapshotError(descriptor, error instanceof Error ? error.message : String(error)));
    }
  }
  return snapshots;
}
const ready = restore(workerData.variables);
parentPort.on('message', async message => {
  if (message.type === 'host-result') {
    const pending = hostCalls.get(message.id);
    if (pending === undefined) return;
    hostCalls.delete(message.id);
    if (message.ok) pending.resolve(message.value);
    else {
      activeHostError = {
        message: message.error ?? 'RLM host call failed',
        ...(message.errorCode === undefined ? {} : { code: message.errorCode }),
      };
      pending.reject(Object.assign(new Error(activeHostError.message), activeHostError.code === undefined ? {} : { code: activeHostError.code }));
    }
    return;
  }
  if (message.type !== 'execute') return;
  try {
    activeExecutionId = message.id;
    activeHostError = undefined;
    await ready;
    for (const declaration of message.declarations) {
      if (RESERVED.has(declaration.name)) continue;
      declarations.set(declaration.name, declaration);
      degradedDeclarations.delete(declaration.name);
    }
    const logs = [];
    activeLogs = logs;
    const value = await evaluate(message.code);
    const output = jsonValue(value);
    let context = contextValue(server.context.context);
    let contextError;
    let contextBytes = 0;
    if (context === undefined) {
      contextError = 'context is not a JSON object';
    } else {
      contextBytes = Buffer.byteLength(JSON.stringify(context), 'utf8');
      if (contextBytes > workerData.snapshotLimits.maxVariableBytes) {
        context = undefined;
        contextError = 'exceeds per-variable snapshot size cap';
      } else if (contextBytes > workerData.snapshotLimits.maxBytes) {
        context = undefined;
        contextError = 'exceeds aggregate snapshot size cap';
      }
    }
    const variables = await snapshotVariables(context === undefined ? 0 : contextBytes);
    parentPort.postMessage({ type: 'execute-result', id: message.id, ok: true, result: {
      logs,
      ...(output === undefined ? {} : { value: output }),
      ...(context === undefined ? {} : { context }),
      display: inspect(value, { colors: false, depth: 6, maxArrayLength: 100, maxStringLength: 8000 }),
      variables,
      degradedVariables: [
        ...variables.filter(variable => variable.error !== undefined).map(variable => variable.name),
        ...(contextError === undefined ? [] : ['context']),
      ],
    } });
    activeExecutionId = undefined;
  } catch (error) {
    parentPort.postMessage({
      type: 'execute-result',
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      errorCode: error instanceof Error && typeof error.code === 'string' ? error.code : undefined,
    });
    activeExecutionId = undefined;
  } finally {
    activeLogs = undefined;
  }
});
parentPort.postMessage({ type: 'ready' });
`

/** One persistent namespace. A synchronous runaway cell can be terminated without blocking its owner daemon. */
export class PersistentTypeScriptKernel {
  private readonly worker: Worker
  private readonly pending = new Map<number, PendingCell>()
  private readonly ready: Promise<void>
  private readonly acceptReady: () => void
  private readonly rejectReady: (error: Error) => void
  private ordinal = 0
  private disposed = false

  constructor(
    context: Readonly<Record<string, RlmJsonValue>>,
    private readonly hooks: KernelHooks,
    variables: readonly PersistedVariable[],
    snapshotLimits: KernelSnapshotLimits = {
      maxBytes: RLM_SNAPSHOT_MAX_BYTES,
      maxVariableBytes: RLM_SNAPSHOT_MAX_VARIABLE_BYTES,
    },
  ) {
    if (!Number.isSafeInteger(snapshotLimits.maxBytes) || snapshotLimits.maxBytes < 1
      || !Number.isSafeInteger(snapshotLimits.maxVariableBytes) || snapshotLimits.maxVariableBytes < 1
      || snapshotLimits.maxVariableBytes > snapshotLimits.maxBytes) {
      throw new Error('invalid RLM namespace snapshot limits')
    }
    const ready = Promise.withResolvers<void>()
    this.ready = ready.promise
    this.acceptReady = ready.resolve
    this.rejectReady = ready.reject
    this.worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        context: structuredClone(context),
        variables: structuredClone(variables),
        snapshotLimits: structuredClone(snapshotLimits),
      },
    })
    this.worker.on('message', (message: WorkerMessage) => { void this.onMessage(message) })
    this.worker.on('error', (error) => { this.failAll(error) })
    this.worker.on('exit', (code) => {
      if (!this.disposed && code !== 0) this.failAll(new Error(`TypeScript REPL Worker exited with code ${String(code)}`))
    })
  }

  /**
   * Execute one serial cell in this namespace.
   * @param code - TypeScript source with top-level await.
   * @param timeoutMs - hard Worker deadline.
   * @returns settled output and independently restorable variables.
   */
  async execute(code: string, timeoutMs: number): Promise<KernelCellResult> {
    await this.ready
    if (this.disposed) throw new Error('TypeScript REPL Worker is not available')
    const analyzed = analyzeTypeScriptCell(code)
    const id = ++this.ordinal
    return new Promise<KernelCellResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        const error = Object.assign(new Error(`TypeScript REPL cell exceeded ${String(timeoutMs)} ms`), { code: 'RLM_CELL_TIMEOUT' })
        reject(error)
        this.disposed = true
        void this.worker.terminate()
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.worker.postMessage({ type: 'execute', id, code: analyzed.code, declarations: analyzed.declarations })
    })
  }

  /**
   * Terminate this Worker and reject every pending cell.
   * @returns after the termination request is issued.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.failAll(new Error('TypeScript REPL Worker disposed'))
    void this.worker.terminate()
  }

  private async onMessage(message: WorkerMessage): Promise<void> {
    if (message.type === 'ready') {
      this.acceptReady()
      return
    }
    if (message.type === 'execute-result' && message.id !== undefined) {
      const pending = this.pending.get(message.id)
      if (pending === undefined) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.ok && message.result !== undefined) pending.resolve(message.result)
      else pending.reject(Object.assign(
        new Error(message.error ?? 'TypeScript REPL cell failed'),
        message.errorCode === undefined ? {} : { code: message.errorCode },
      ))
      return
    }
    if (message.type !== 'host-call' || message.id === undefined || message.method === undefined) return
    try {
      const value = await this.callHost(message.method, message.args ?? [])
      this.worker.postMessage({ type: 'host-result', id: message.id, ok: true, value })
    } catch (error) {
      this.worker.postMessage({
        type: 'host-result',
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        errorCode: error instanceof Error && 'code' in error ? String(error.code) : undefined,
      })
    }
  }

  private callHost(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case 'spawn': return this.hooks.spawn(args[0] as string, args[1])
      case 'listChildren': return this.hooks.listChildren()
      case 'deleteChild': return this.hooks.deleteChild(args[0])
      case 'sendMessage': return this.hooks.sendMessage(args[0] as string, args[1] as Parameters<KernelHooks['sendMessage']>[1])
      case 'broadcastMessage': return this.hooks.broadcastMessage(args[0] as string, args[1] as Parameters<KernelHooks['broadcastMessage']>[1])
      case 'listAgents': return this.hooks.listAgents()
      case 'readMessages': return this.hooks.readMessages(args[0] as number | undefined, args[1] as number | undefined)
      case 'harness': return this.hooks.harness(args[0] as string, args[1] as Readonly<Record<string, RlmJsonValue>>)
      case 'skill': return this.hooks.skill(args[0] as 'skills.list' | 'skills.call', args[1] as Readonly<Record<string, RlmJsonValue>>)
      case 'setGoal': return this.hooks.setGoal(args[0] as string, args[1] as Parameters<KernelHooks['setGoal']>[1])
      case 'getGoal': return this.hooks.getGoal()
      case 'completeGoal': return this.hooks.completeGoal()
      case 'createHeartbeat': return this.hooks.createHeartbeat(args[0] as string, args[1] as Parameters<KernelHooks['createHeartbeat']>[1])
      case 'listHeartbeats': return this.hooks.listHeartbeats(args[0] as boolean | undefined)
      case 'updateHeartbeat': return this.hooks.updateHeartbeat(args[0] as string, args[1] as Parameters<KernelHooks['updateHeartbeat']>[1])
      case 'deleteHeartbeat': return this.hooks.deleteHeartbeat(args[0] as string)
      case 'compactStatus': return this.hooks.compactStatus()
      case 'compactRun': return this.hooks.compactRun(args[0] as Parameters<KernelHooks['compactRun']>[0])
      default: return Promise.reject(new Error(`unknown TypeScript REPL host method: ${method}`))
    }
  }

  private failAll(error: Error): void {
    this.rejectReady(error)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
