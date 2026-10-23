import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { EgoProcessError } from '../src/process-contract.js'
import { runEgoProcess } from '../src/process.js'

const fixtureCwd = new URL('./fixtures/', import.meta.url).pathname
const executable = process.execPath
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-chatgpt-web-process-'))
  temporaryDirectories.push(directory)
  return directory
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<EgoProcessError> {
  const caught = await promise.catch((error: unknown) => error)
  expect(caught).toBeInstanceOf(EgoProcessError)
  expect(caught).toMatchObject({ code })
  return caught as EgoProcessError
}

function request(source: string, overrides: Partial<Parameters<typeof runEgoProcess>[0]> = {}) {
  return {
    executable,
    source,
    cwd: fixtureCwd,
    timeoutMs: 2_000,
    stdoutMaxBytes: 4_096,
    stderrMaxBytes: 256,
    ...overrides,
  }
}

describe('runEgoProcess', () => {
  it('sends the trusted source through stdin with the fixed nodejs argument', async () => {
    const result = await runEgoProcess(request('echo:stdin payload'))
    expect(result).toEqual({ stdout: 'stdin payload', stderr: '', stderrTruncated: false, exitCode: 0, executionStopped: true })
  })

  it('preserves browser/Ego environment and scrubs provider credentials', async () => {
    const directory = await temporaryDirectory()
    const report = join(directory, 'env.json')
    const result = await runEgoProcess(request(`env:${report}`, {
      timeoutMs: 2_000,
      stdoutMaxBytes: 64,
    }))
    expect(result.exitCode).toBe(0)
    const values = JSON.parse(await readFile(report, 'utf8')) as Record<string, string | undefined>
    expect(values.home).toBe(process.env.HOME)
    expect(values.ego).toBe(process.env.EGO_TASK_SPACE)
    expect(values.openai).toBeUndefined()
    expect(values.anthropic).toBeUndefined()
    expect(values.deepseek).toBeUndefined()
  })

  it('reports a nonzero process exit and keeps only the stderr tail', async () => {
    const failure = await expectCode(runEgoProcess(request('fail:abcdef', { stderrMaxBytes: 3 })), 'EGO_PROCESS_FAILED')
    expect(failure.stderr).toBe('def')
    expect(failure.executionStopped).toBe(true)
    expect(failure.mayHaveLateEffects).toBe(true)
  })

  it('marks a bounded stderr tail as truncated instead of claiming complete output', async () => {
    const text = 'n'.repeat(512)
    const result = await runEgoProcess(request(`stderr:${text}`, { stderrMaxBytes: 32 }))
    expect(result.stderr).toBe(text.slice(-32))
    expect(result.stderrTruncated).toBe(true)
  })

  it('stops once stdout exceeds its full-retention bound', async () => {
    const failure = await expectCode(runEgoProcess(request('large:128', { stdoutMaxBytes: 32 })), 'EGO_OUTPUT_TOO_LARGE')
    expect(failure.message).not.toContain('x'.repeat(32))
    expect(failure.stderr).toBe('')
    expect(failure.executionStopped).toBe(true)
    expect(failure.mayHaveLateEffects).toBe(true)
  })

  it('terminates descendants on timeout without retrying', async () => {
    const directory = await temporaryDirectory()
    const childPidFile = join(directory, 'child.pid')
    const failure = await expectCode(runEgoProcess(request(`descendant:${childPidFile}`, {
      timeoutMs: 500,
    })), 'EGO_TIMEOUT')
    expect(failure.executionStopped).toBe(true)
    await expect(stat(childPidFile)).resolves.toBeTruthy()
    const childPid = Number(await readFile(childPidFile, 'utf8'))
    expect(Number.isInteger(childPid)).toBe(true)
    expect(() => process.kill(childPid, 0)).toThrow()
  })

  it('returns after forced cleanup when an escaped descendant prevents close', async () => {
    const directory = await temporaryDirectory()
    const childPidFile = join(directory, 'escaped-child.pid')
    let childPid: number | undefined
    try {
      const startedAt = Date.now()
      const failure = await expectCode(runEgoProcess(request(`escaped:${childPidFile}`, { timeoutMs: 500 })), 'EGO_TIMEOUT')
      expect(Date.now() - startedAt).toBeLessThan(3_000)
      childPid = Number(await readFile(childPidFile, 'utf8'))
      expect(Number.isInteger(childPid)).toBe(true)
      expect(() => process.kill(childPid!, 0)).not.toThrow()
      expect(failure.executionStopped).toBe(true)
      expect(failure.mayHaveLateEffects).toBe(true)
    } finally {
      if (childPid !== undefined) {
        try { process.kill(childPid, 'SIGKILL') } catch { /* fixture already exited */ }
      }
    }
  })

  it('does not retry a timed-out launch', async () => {
    const directory = await temporaryDirectory()
    const countFile = join(directory, 'count')
    await expectCode(runEgoProcess(request(`count-sleep:${countFile}`, { timeoutMs: 500 })), 'EGO_TIMEOUT')
    await expect(readFile(countFile, 'utf8')).resolves.toBe('1\n')
  })

  it('terminates on cancellation and reports the cancellation boundary', async () => {
    const controller = new AbortController()
    const running = runEgoProcess(request('sleep:1000', { signal: controller.signal }))
    controller.abort()
    const failure = await expectCode(running, 'EGO_ABORTED')
    expect(failure.executionStopped).toBe(true)
    expect(failure.mayHaveLateEffects).toBe(true)
  })

  it('does not spawn after a pre-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const directory = await temporaryDirectory()
    const countFile = join(directory, 'count')
    const failure = await expectCode(runEgoProcess(request(`count:${countFile}`, { signal: controller.signal })), 'EGO_ABORTED')
    expect(failure.executionStopped).toBe(true)
    await expect(access(countFile, constants.F_OK)).rejects.toThrow()
  })

  it('reports launch failure without retrying', async () => {
    const failure = await expectCode(runEgoProcess(request('echo:nope', { executable: join(fixtureCwd, 'missing-executable') })), 'EGO_SPAWN_FAILED')
    expect(failure.executionStopped).toBe(true)
    expect(failure.mayHaveLateEffects).toBe(false)
  })
})
