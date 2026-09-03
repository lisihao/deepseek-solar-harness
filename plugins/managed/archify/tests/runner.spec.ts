import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { executeArchify, type ArchifySubprocess } from '../src/runner.ts'
import { readCas } from '../src/receipt-store.ts'
import type { ArchifyToolArgs } from '../src/types.ts'

const examples = {
  architecture: 'web-app.architecture.json',
  workflow: 'agent-tool-call.workflow.json',
  sequence: 'async-job-roundtrip.sequence.json',
  dataflow: 'event-stream.dataflow.json',
  lifecycle: 'agent-run.lifecycle.json',
} as const

const exampleRoot = join(process.cwd(), 'vendor/archify/examples')

function exec(workspace: string, signal = new AbortController().signal): { signal: AbortSignal; agent: { session: { header: { cwd: string } } } } {
  return { signal, agent: { session: { header: { cwd: workspace } } } }
}

async function withSubprocess<T>(run: (subprocess: NonNullable<Parameters<typeof executeArchify>[3]>) => Promise<T>): Promise<T> {
  const ctx = new Context()
  const fiber = await ctx.plugin(LocalSubprocessRuntime)
  try {
    return await run(ctx.subprocess)
  } finally {
    await fiber.dispose()
  }
}

function controlledSubprocess(): { subprocess: ArchifySubprocess; terminate: ReturnType<typeof vi.fn> } {
  let settle!: (outcome: { exitCode: number | null; signal: NodeJS.Signals | null }) => void
  const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(resolve => { settle = resolve })
  const read = { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }
  const terminate = vi.fn(() => { settle({ exitCode: null, signal: 'SIGTERM' }) })
  const handle = {
    pid: 1,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: { stdout: read, stderr: read },
    done,
    terminate,
    waitForExit: async () => true,
  }
  return {
    subprocess: {
      resolveExecutable: vi.fn(async () => process.execPath),
      spawn: vi.fn(() => handle),
    },
    terminate,
  }
}

async function readExample(type: keyof typeof examples): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(exampleRoot, examples[type]), 'utf8')) as Record<string, unknown>
}

describe('Archify DSH adapter', () => {
  it('runs the exact upstream validator for all five diagram types', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-archify-test-'))
    const workspace = join(root, 'workspace')
    const artifactRoot = join(root, 'artifacts')
    await withSubprocess(async subprocess => {
      for (const type of Object.keys(examples) as Array<keyof typeof examples>) {
        const result = await executeArchify({
          action: 'validate',
          type,
          input: await readExample(type),
          quality: 'showcase',
        }, exec(workspace), { artifactRoot }, subprocess)
        expect(result.ok, `${type} validation failed`).toBe(true)
        expect(result.receiptRef).toMatch(/^sha256:[0-9a-f]{64}$/u)
        const receipt = JSON.parse((await readCas(artifactRoot, result.receiptRef)).toString('utf8')) as Record<string, unknown>
        expect(receipt.upstream).toMatchObject({ commit: 'c826e6c3a7abad19c0f3cd1ca57207d54b1ad8de' })
        expect(receipt).not.toHaveProperty('prompt')
        const command = receipt.command as Record<string, unknown>
        const upstream = JSON.parse(command.stdout as string) as Record<string, unknown>
        expect(upstream.checks).toHaveLength(9)
        expect(upstream.composition).toMatchObject({ profile: 'showcase', status: 'pass' })
      }
    })
  }, 30_000)

  it('delivers HTML and records a content-addressed adapter receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-archify-deliver-'))
    await withSubprocess(async subprocess => {
      const result = await executeArchify({
        action: 'deliver',
        type: 'architecture',
        input: await readExample('architecture'),
        quality: 'showcase',
        outputName: 'architecture.html',
      }, exec(join(root, 'workspace')), { artifactRoot: root }, subprocess)
      expect(result.ok).toBe(true)
      expect(result.artifactRef?.kind).toBe('html')
      expect(result.deliveryPath).toBe(join(root, 'deliveries', 'architecture.html'))
      await expect(stat(result.deliveryPath as string)).resolves.toMatchObject({ isFile: expect.any(Function) })
      const receipt = JSON.parse((await readCas(root, result.receiptRef)).toString('utf8')) as Record<string, unknown>
      expect(receipt).toMatchObject({ plugin: '@deepseek-ai/dsh-archify', action: 'deliver', ok: true })
      const command = receipt.command as Record<string, unknown>
      const upstream = JSON.parse(command.stdout as string) as Record<string, unknown>
      expect(upstream.validation).toMatchObject({ checksPassed: 9, checkCount: 9, compositionProfile: 'showcase', compositionStatus: 'pass' })
    })
  }, 30_000)

  it('runs Architecture Delta through the upstream compare runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-archify-compare-'))
    const base = await readExample('architecture')
    const head = structuredClone(base)
    await withSubprocess(async subprocess => {
      const result = await executeArchify({
        action: 'compare',
        baseInput: base,
        headInput: head,
      }, exec(join(root, 'workspace')), { artifactRoot: root }, subprocess)
      expect(result.ok).toBe(true)
      expect(result.artifactRef?.kind).toBe('html')
      expect(result.upstreamReceipt).toBeDefined()
      expect(result.upstreamReceiptRef?.kind).toBe('receipt')
      expect(result.upstreamReceiptRef?.ref).toMatch(/^sha256:[0-9a-f]{64}$/u)
      const upstream = JSON.parse((await readCas(root, result.upstreamReceiptRef!.ref)).toString('utf8')) as Record<string, unknown>
      expect(upstream).toMatchObject({ command: 'compare', schemaVersion: 1 })
    })
  }, 30_000)

  it('rejects visual checks outside the plugin artifact root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-archify-path-'))
    await withSubprocess(async subprocess => {
      await expect(executeArchify({
        action: 'visual-check',
        htmlPath: join(root, '..', 'outside.html'),
      }, exec(join(root, 'workspace')), { artifactRoot: root }, subprocess)).rejects.toThrow('inside the Archify artifact root')
    })
  })

  it('rejects unsafe named delivery paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-archify-name-'))
    const args: ArchifyToolArgs = {
      action: 'deliver',
      type: 'architecture',
      input: await readExample('architecture'),
      outputName: '../escape',
    }
    await withSubprocess(async subprocess => {
      await expect(executeArchify(args, exec(join(root, 'workspace')), { artifactRoot: root }, subprocess)).rejects.toThrow('outputName')
    })
  })

  it('keeps process execution on the injected subprocess seam', async () => {
    const source = await readFile(join(process.cwd(), 'src/runner.ts'), 'utf8')
    expect(source).not.toContain("node:child_process")
    expect(source).toContain('options.subprocess.spawn')
  })

  it('returns a structured failure for invalid upstream input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-archify-invalid-'))
    await withSubprocess(async subprocess => {
      const result = await executeArchify({
        action: 'validate',
        type: 'architecture',
        input: { schema_version: 1 },
      }, exec(join(root, 'workspace')), { artifactRoot: root }, subprocess)
      expect(result.ok).toBe(false)
      expect(result.error?.code).toBe('ARCHIFY_COMMAND_FAILED')
      expect(result.receiptRef).toMatch(/^sha256:[0-9a-f]{64}$/u)
    })
  })

  it('propagates timeout and caller cancellation through the injected handle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-archify-process-control-'))
    const timeoutControl = controlledSubprocess()
    const timedOut = await executeArchify({ action: 'doctor' }, exec(join(root, 'timeout-workspace')), { artifactRoot: root, timeoutMs: 5 }, timeoutControl.subprocess)
    expect(timedOut.ok).toBe(false)
    expect(timedOut.error?.code).toBe('ARCHIFY_TIMEOUT')
    expect(timeoutControl.terminate).toHaveBeenCalledOnce()

    const abortControl = controlledSubprocess()
    const controller = new AbortController()
    const pending = executeArchify({ action: 'doctor' }, exec(join(root, 'abort-workspace'), controller.signal), { artifactRoot: root, timeoutMs: 30_000 }, abortControl.subprocess)
    controller.abort('caller cancelled')
    const aborted = await pending
    expect(aborted.ok).toBe(false)
    expect(abortControl.terminate).toHaveBeenCalledOnce()
  })
})
