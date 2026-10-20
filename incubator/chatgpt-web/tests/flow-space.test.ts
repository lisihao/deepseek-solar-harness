import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { FlowSpaces } from '../src/flow-space.js'
import type { EgoProcessRequest, EgoProcessResult } from '../src/process-contract.js'

const MARKER = '__SOLAR_FLOW_SPACE__:'
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-chatgpt-web-flow-space-'))
  roots.push(root)
  return root
}

function frame(value: unknown): EgoProcessResult {
  return {
    stdout: `${MARKER}${JSON.stringify(value)}\n`,
    stderr: '',
    exitCode: 0,
    executionStopped: true,
  }
}

function options(root: string, runner: (request: EgoProcessRequest) => Promise<EgoProcessResult>) {
  return { root, executable: '/usr/local/bin/ego-browser', commandTimeoutMs: 1_000, runner }
}

function recordPath(root: string, runId: string): string {
  return join(root, 'flow-spaces', `${runId}.json`)
}

function createRunner(onCreate: () => Promise<EgoProcessResult> | EgoProcessResult, onFinish: () => Promise<EgoProcessResult> | EgoProcessResult) {
  const calls = { create: 0, list: 0, finish: 0 }
  const runner = vi.fn(async ({ source }: EgoProcessRequest): Promise<EgoProcessResult> => {
    if (source.includes('listTaskSpaces')) {
      calls.list += 1
      return frame({ spaceId: 7 })
    }
    if (source.includes('task.finish')) {
      calls.finish += 1
      return onFinish()
    }
    calls.create += 1
    return onCreate()
  })
  return { calls, runner }
}

describe('FlowSpaces', () => {
  it('shares a concurrent forRun promise and creates one space', async () => {
    const root = await makeRoot()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fixture = createRunner(async () => {
      await gate
      return frame({ spaceId: 7 })
    }, () => frame({ finished: true }))
    const spaces = new FlowSpaces(options(root, fixture.runner))
    const runId = randomUUID()

    const first = spaces.forRun(runId)
    const second = spaces.forRun(runId)
    expect(second).toBe(first)
    release()

    await expect(first).resolves.toBe(7)
    expect(fixture.calls).toEqual({ create: 1, list: 0, finish: 0 })
    await expect(readFile(recordPath(root, runId), 'utf8')).resolves.toContain('"state":"ready"')
  })

  it('reconciles an unknown create receipt by exact name after restart without creating another space', async () => {
    const root = await makeRoot()
    const runId = randomUUID()
    let createdName = ''
    const calls = { create: 0, list: 0 }
    const runner = vi.fn(async ({ source }: EgoProcessRequest): Promise<EgoProcessResult> => {
      if (source.includes('listTaskSpaces')) {
        calls.list += 1
        expect(source).toContain(JSON.stringify(createdName))
        return frame({ spaceId: 19 })
      }
      calls.create += 1
      const match = source.match(/taskSpace\(("(?:\\.|[^"\\])*")\)/)
      expect(match?.[1]).toBeDefined()
      createdName = JSON.parse(match![1]!) as string
      return { stdout: '', stderr: '', exitCode: 0, executionStopped: true }
    })

    const first = new FlowSpaces(options(root, runner))
    await expect(first.forRun(runId)).rejects.toMatchObject({ message: expect.stringContaining('FLOW_SPACE_RECEIPT_UNKNOWN') })

    const restarted = new FlowSpaces(options(root, runner))
    await expect(restarted.forRun(runId)).resolves.toBe(19)
    expect(calls).toEqual({ create: 1, list: 1 })
    await expect(readFile(recordPath(root, runId), 'utf8')).resolves.toContain('"state":"ready"')
  })

  it('never reopens a finished space', async () => {
    const root = await makeRoot()
    const fixture = createRunner(() => frame({ spaceId: 23 }), () => frame({ finished: true }))
    const spaces = new FlowSpaces(options(root, fixture.runner))
    const runId = randomUUID()

    await expect(spaces.forRun(runId)).resolves.toBe(23)
    await expect(spaces.finish(runId)).resolves.toBeUndefined()
    await expect(spaces.forRun(runId)).rejects.toMatchObject({ message: expect.stringContaining('FLOW_SPACE_CLOSED') })
    expect(fixture.calls).toEqual({ create: 1, list: 0, finish: 1 })
  })

  it('shares concurrent finish calls within an instance', async () => {
    const root = await makeRoot()
    let finishStarted!: () => void
    const started = new Promise<void>((resolve) => { finishStarted = resolve })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fixture = createRunner(() => frame({ spaceId: 29 }), async () => {
      finishStarted()
      await gate
      return frame({ finished: true })
    })
    const spaces = new FlowSpaces(options(root, fixture.runner))
    const runId = randomUUID()
    await spaces.forRun(runId)

    const first = spaces.finish(runId)
    const second = spaces.finish(runId)
    expect(second).toBe(first)
    await started
    expect(fixture.calls.finish).toBe(1)
    release()
    await expect(first).resolves.toBeUndefined()
  })

  it('uses a wx finish admission so cross-instance finish calls never finish externally twice', async () => {
    const root = await makeRoot()
    let finishStarted!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => { finishStarted = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fixture = createRunner(() => frame({ spaceId: 31 }), async () => {
      finishStarted()
      await gate
      return frame({ finished: true })
    })
    const first = new FlowSpaces(options(root, fixture.runner))
    const second = new FlowSpaces(options(root, fixture.runner))
    const runId = randomUUID()
    await first.forRun(runId)

    const firstFinish = first.finish(runId)
    await started
    const secondFinish = second.finish(runId)
    await expect(secondFinish).rejects.toMatchObject({ message: expect.stringContaining('FLOW_SPACE_FINISH_UNKNOWN') })
    expect(fixture.calls.finish).toBe(1)
    release()
    await expect(firstFinish).resolves.toBeUndefined()
  })

  it('rejects unknown versions, malformed JSON, and invalid persisted state boundaries with named errors', async () => {
    const root = await makeRoot()
    const runId = randomUUID()
    await mkdir(join(root, 'flow-spaces'), { recursive: true })
    const spaces = new FlowSpaces(options(root, async () => frame({ spaceId: 1 })))
    const path = recordPath(root, runId)

    await writeFile(path, '{not-json', { mode: 0o600 })
    await expect(spaces.forRun(runId)).rejects.toMatchObject({ message: expect.stringContaining('FLOW_SPACE_INVALID') })

    const invalidRecords: readonly unknown[] = [
      { formatVersion: 99, runId, name: `Solar execution ${runId}`, state: 'creating' },
      { formatVersion: 1, runId, name: `Solar execution ${runId}`, state: 'creating', spaceId: 1 },
      { formatVersion: 1, runId, name: `Solar execution ${runId}`, state: 'ready' },
      { formatVersion: 1, runId, name: `Solar execution ${runId}`, state: 'finishing' },
      { formatVersion: 1, runId, name: `Solar execution ${runId}`, state: 'finished' },
    ]
    for (const record of invalidRecords) {
      await writeFile(path, JSON.stringify(record), { mode: 0o600 })
      const expected = (record as { formatVersion?: number }).formatVersion === 99 ? 'FLOW_SPACE_VERSION' : 'FLOW_SPACE_INVALID'
      await expect(spaces.forRun(runId)).rejects.toMatchObject({ message: expect.stringContaining(expected) })
    }
  })

  it('records an unknown finish and never repeats the external finish', async () => {
    const root = await makeRoot()
    const fixture = createRunner(() => frame({ spaceId: 37 }), () => ({ stdout: '', stderr: '', exitCode: 0, executionStopped: true }))
    const spaces = new FlowSpaces(options(root, fixture.runner))
    const runId = randomUUID()
    await spaces.forRun(runId)

    await expect(spaces.finish(runId)).rejects.toMatchObject({ message: expect.stringContaining('FLOW_SPACE_RECEIPT_UNKNOWN') })
    await expect(spaces.finish(runId)).rejects.toMatchObject({ message: expect.stringContaining('FLOW_SPACE_FINISH_UNKNOWN') })
    expect(fixture.calls.finish).toBe(1)
    await expect(readFile(recordPath(root, runId), 'utf8')).resolves.toContain('"state":"finishing"')
  })
})
