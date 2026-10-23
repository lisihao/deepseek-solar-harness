import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { runEgoProcess } from './process.js'
import type { EgoProcessRequest, EgoProcessResult } from './process-contract.js'

const MARKER = '__SOLAR_FLOW_SPACE__:'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
type SpaceState = 'creating' | 'ready' | 'finishing' | 'finished'
interface SpaceRecord { formatVersion: 1; runId: string; name: string; state: SpaceState; spaceId?: number }
interface FinishAdmission { formatVersion: 1; runId: string; spaceId: number }
export interface FlowSpacesOptions {
  readonly root: string
  readonly executable: string
  readonly commandTimeoutMs: number
  readonly runner?: (request: EgoProcessRequest) => Promise<EgoProcessResult>
}
/** One browser TaskSpace for an entire edited Web/Insight execution. */
export class FlowSpaces {
  private readonly pending = new Map<string, Promise<number>>()
  private readonly finishing = new Map<string, Promise<void>>()
  constructor(private readonly options: FlowSpacesOptions) {}
  private path(id: string): string {
    if (!UUID.test(id)) throw new Error('FLOW_RUN_ID_INVALID: 流程运行标识无效。')
    return join(this.options.root, 'flow-spaces', `${id}.json`)
  }
  private finishPath(id: string): string {
    return join(this.options.root, 'flow-spaces', `${id}.finish.json`)
  }
  private async read(id: string): Promise<SpaceRecord | undefined> {
    let text: string
    try { text = await readFile(this.path(id), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    let value: unknown
    try { value = JSON.parse(text) as unknown } catch { throw new Error('FLOW_SPACE_INVALID: 浏览器资源记录损坏。') }
    if (typeof value !== 'object' || value === null || !('formatVersion' in value) || value.formatVersion !== 1) throw new Error('FLOW_SPACE_VERSION: 不支持的浏览器资源记录版本。')
    const v = value as Record<string, unknown>
    const states: readonly SpaceState[] = ['creating', 'ready', 'finishing', 'finished']
    if (v.runId !== id || typeof v.name !== 'string' || v.name.length === 0 || !states.includes(v.state as SpaceState)) throw new Error('FLOW_SPACE_INVALID: 浏览器资源记录损坏。')
    const state = v.state as SpaceState
    const hasSpaceId = Object.prototype.hasOwnProperty.call(v, 'spaceId')
    const allowedKeys = state === 'creating' ? ['formatVersion', 'runId', 'name', 'state'] : ['formatVersion', 'runId', 'name', 'state', 'spaceId']
    if (Object.keys(v).some((key) => !allowedKeys.includes(key))) throw new Error('FLOW_SPACE_INVALID: 浏览器资源记录损坏。')
    if (state === 'creating' && hasSpaceId) throw new Error('FLOW_SPACE_INVALID: 浏览器资源记录损坏。')
    if (state !== 'creating' && (!hasSpaceId || !Number.isSafeInteger(v.spaceId) || Number(v.spaceId) <= 0)) throw new Error('FLOW_SPACE_INVALID: 浏览器资源记录损坏。')
    return value as SpaceRecord
  }
  private async readFinishAdmission(id: string): Promise<FinishAdmission> {
    let text: string
    try { text = await readFile(this.finishPath(id), 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('FLOW_SPACE_FINISH_UNKNOWN: 浏览器空间结束意图缺失，未重复结束。')
      throw error
    }
    let value: unknown
    try { value = JSON.parse(text) as unknown } catch { throw new Error('FLOW_SPACE_FINISH_INVALID: 浏览器空间结束意图损坏。') }
    if (typeof value !== 'object' || value === null || !('formatVersion' in value) || value.formatVersion !== 1) throw new Error('FLOW_SPACE_FINISH_VERSION: 不支持的浏览器空间结束意图版本。')
    const v = value as Record<string, unknown>
    if (Object.keys(v).some((key) => !['formatVersion', 'runId', 'spaceId'].includes(key)) || v.runId !== id || !Number.isSafeInteger(v.spaceId) || Number(v.spaceId) <= 0) throw new Error('FLOW_SPACE_FINISH_INVALID: 浏览器空间结束意图损坏。')
    return value as FinishAdmission
  }
  private async write(record: SpaceRecord): Promise<void> {
    const target = this.path(record.runId)
    const temporary = `${target}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(record) + '\n', { mode: 0o600 })
    await rename(temporary, target)
  }
  private async invoke(code: string, signal?: AbortSignal): Promise<unknown> {
    const result = await (this.options.runner ?? runEgoProcess)({ executable: this.options.executable, source: code, cwd: this.options.root, timeoutMs: this.options.commandTimeoutMs, stdoutMaxBytes: 64 * 1024, stderrMaxBytes: 16 * 1024, ...(signal === undefined ? {} : { signal }) })
    const frames = (result.stdout + '\n' + result.stderr).split('\n').filter(line => line.startsWith(MARKER))
    if (frames.length !== 1) throw new Error('FLOW_SPACE_RECEIPT_UNKNOWN: 浏览器资源回执不确定，未创建替代空间。')
    try { return JSON.parse(frames[0]!.slice(MARKER.length)) as unknown } catch { throw new Error('FLOW_SPACE_RECEIPT_UNKNOWN: 浏览器资源回执不确定，未创建替代空间。') }
  }
  forRun(runId: string, signal?: AbortSignal): Promise<number> {
    const active = this.pending.get(runId)
    if (active) return active
    let promise: Promise<number>
    promise = this.obtain(runId, signal).finally(() => {
      if (this.pending.get(runId) === promise) this.pending.delete(runId)
    })
    this.pending.set(runId, promise)
    return promise
  }
  private async obtain(runId: string, signal?: AbortSignal): Promise<number> {
    await mkdir(join(this.options.root, 'flow-spaces'), { recursive: true, mode: 0o700 })
    let record = await this.read(runId)
    let mayCreate = false
    if (!record) {
      record = { formatVersion: 1, runId, name: `Solar execution ${runId}`, state: 'creating' }
      try { await writeFile(this.path(runId), JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 }); mayCreate = true }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; record = await this.read(runId) }
    }
    if (!record) throw new Error('FLOW_SPACE_INVALID: 浏览器资源记录缺失。')
    if (record.state === 'finished' || record.state === 'finishing') throw new Error('FLOW_SPACE_CLOSED: 该流程的浏览器空间已结束或结束结果待核对。')
    if (record.state === 'ready' && record.spaceId !== undefined) return record.spaceId
    const code = mayCreate
      ? `const task = await taskSpace(${JSON.stringify(record.name)}); if(task.ownership !== "agent") throw new Error("WEB_USER_CONTROL"); console.log(${JSON.stringify(MARKER)} + JSON.stringify({spaceId:task.spaceId}));`
      : `const matches = (await listTaskSpaces()).filter(t => t.name === ${JSON.stringify(record.name)}); if(matches.length !== 1 || matches[0].ownership !== "agent") throw new Error("FLOW_SPACE_RECEIPT_UNKNOWN"); console.log(${JSON.stringify(MARKER)} + JSON.stringify({spaceId:matches[0].spaceId}));`
    const value = await this.invoke(code, signal)
    if (typeof value !== 'object' || value === null || !('spaceId' in value) || !Number.isSafeInteger(value.spaceId) || Number(value.spaceId) <= 0) throw new Error('FLOW_SPACE_RECEIPT_UNKNOWN: 未取得唯一的浏览器空间回执。')
    const ready: SpaceRecord = { ...record, state: 'ready', spaceId: Number(value.spaceId) }
    await this.write(ready)
    return ready.spaceId!
  }
  finish(runId: string): Promise<void> {
    const active = this.finishing.get(runId)
    if (active) return active
    let promise: Promise<void>
    promise = this.finishOnce(runId).finally(() => {
      if (this.finishing.get(runId) === promise) this.finishing.delete(runId)
    })
    this.finishing.set(runId, promise)
    return promise
  }
  private async admitFinish(record: SpaceRecord): Promise<boolean> {
    const admission: FinishAdmission = { formatVersion: 1, runId: record.runId, spaceId: record.spaceId! }
    try {
      await writeFile(this.finishPath(record.runId), JSON.stringify(admission) + '\n', { flag: 'wx', mode: 0o600 })
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = await this.readFinishAdmission(record.runId)
      if (existing.spaceId !== record.spaceId) throw new Error('FLOW_SPACE_FINISH_INVALID: 浏览器空间结束意图与资源不一致。')
      return false
    }
  }
  private async finishOnce(runId: string): Promise<void> {
    const record = await this.read(runId)
    if (!record || record.state === 'finished') return
    if (record.state !== 'ready' || record.spaceId === undefined) throw new Error('FLOW_SPACE_FINISH_UNKNOWN: 浏览器空间状态待核对，未重复结束。')
    if (!await this.admitFinish(record)) {
      const current = await this.read(runId)
      if (!current || current.state === 'finished') return
      throw new Error('FLOW_SPACE_FINISH_UNKNOWN: 浏览器空间结束意图已存在，未重复结束。')
    }
    await this.write({ ...record, state: 'finishing' })
    const value = await this.invoke(`const task=await taskSpace(${record.spaceId}); if(task.ownership!=="agent")throw new Error("WEB_USER_CONTROL"); await task.finish({keep:[]}); console.log(${JSON.stringify(MARKER)}+JSON.stringify({finished:true}));`)
    if (typeof value !== 'object' || value === null || !('finished' in value) || value.finished !== true) throw new Error('FLOW_SPACE_RECEIPT_UNKNOWN: 浏览器空间结束回执不确定，未重复结束。')
    await this.write({ ...record, state: 'finished' })
  }
}
