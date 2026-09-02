import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import {
  artifactRootForWorkspace,
  boundedText,
  canonicalJson,
  contentSha256,
  isContainedPath,
  publishDelivery,
  writeCas,
} from './receipt-store.ts'
import {
  ARCHIFY_ACTIONS,
  ARCHIFY_DIAGRAM_TYPES,
  type ArchifyAction,
  type ArchifyDiagramType,
  type ArchifyQuality,
  type ArchifyToolArgs,
  type ArchifyToolResult,
} from './types.ts'

export const ARCHIFY_SOURCE = {
  repository: 'https://github.com/tt-a1i/archify',
  tag: 'v2.16.0',
  commit: 'c826e6c3a7abad19c0f3cd1ca57207d54b1ad8de',
} as const

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_CAPTURE_BYTES = 16_384
const DEFAULT_MAX_OUTPUT_BYTES = 32_000_000
const DEFAULT_GRACE_MS = 3_000
const ARCHIFY_ROOT = fileURLToPath(new URL('../vendor/archify/', import.meta.url))
const ARCHIFY_CLI = join(ARCHIFY_ROOT, 'bin', 'archify.mjs')

export interface ArchifyConfig {
  readonly artifactRoot?: string
  readonly timeoutMs?: number
  readonly maxCaptureBytes?: number
  readonly maxOutputBytes?: number
}

interface ProcessResult {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

interface CommandOptions {
  readonly subprocess: Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'>
  readonly cwd: string
  readonly signal: AbortSignal
  readonly timeoutMs: number
  readonly maxCaptureBytes: number
}

function workspaceOf(exec: ToolRunContext): string {
  return resolve(exec.agent?.session.header.cwd ?? process.cwd())
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requireType(action: ArchifyAction, type: ArchifyDiagramType | undefined): ArchifyDiagramType {
  if (type !== undefined && (ARCHIFY_DIAGRAM_TYPES as readonly string[]).includes(type)) return type
  throw new Error(`${action} requires one of: ${ARCHIFY_DIAGRAM_TYPES.join(', ')}`)
}

function requireInput(action: ArchifyAction, value: JsonValue | undefined): JsonValue {
  if (value !== undefined && isRecord(value)) return value
  throw new Error(`${action} requires one typed JSON object in input`)
}

function safeName(value: string | undefined, fallback: string): string {
  const name = value?.trim() || fallback
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new Error('outputName must be one relative filename without path traversal')
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name)) {
    throw new Error('outputName must contain only letters, numbers, dot, underscore, or hyphen')
  }
  return name.endsWith('.html') ? name : `${name}.html`
}

function parseJson(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text) as JsonValue
  } catch {
    return undefined
  }
}

function diagnosticsOf(parsed: JsonValue | undefined): JsonValue | undefined {
  if (parsed !== undefined && typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    const diagnostics = parsed.diagnostics
    if (diagnostics !== undefined) return diagnostics
  }
  return undefined
}

function summaryOf(action: ArchifyAction, type: ArchifyDiagramType | undefined, parsed: JsonValue | undefined): string {
  if (action === 'doctor') return 'Archify runtime doctor passed.'
  if (action === 'examples') return 'Archify examples listed.'
  if (action === 'guide') return 'Archify authoring guidance returned.'
  if (action === 'brands') return 'Archify brand catalog query returned.'
  if (action === 'compare') return 'Architecture delta rendered and receipt committed.'
  if (action === 'deliver') return `Delivered ${type ?? 'diagram'} HTML artifact.`
  if (action === 'render') return `Rendered ${type ?? 'diagram'} HTML artifact.`
  if (action === 'inspect') return `Inspected ${type ?? 'diagram'} layout.`
  if (action === 'visual-check') return 'Visual artifact checks returned.'
  if (action === 'migrate') return 'Workflow JSON IR migrated and committed.'
  if (parsed !== undefined && typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && parsed.ok === true) {
    return `Validated ${type ?? 'diagram'} successfully.`
  }
  return `Archify ${action} completed.`
}

function commandFor(args: ArchifyToolArgs, inputPath: string | undefined, basePath: string | undefined, headPath: string | undefined, outputPath: string | undefined): string[] {
  const command = args.action
  switch (command) {
    case 'render': {
      const type = requireType(command, args.type)
      if (inputPath === undefined || outputPath === undefined) throw new Error('render input is unavailable')
      return ['render', type, inputPath, outputPath]
    }
    case 'validate': {
      const type = requireType(command, args.type)
      if (inputPath === undefined) throw new Error('validate input is unavailable')
      return ['validate', type, inputPath, '--json']
    }
    case 'deliver': {
      const type = requireType(command, args.type)
      if (inputPath === undefined || outputPath === undefined) throw new Error('deliver input is unavailable')
      return ['deliver', type, inputPath, outputPath, '--json']
    }
    case 'compare':
      if (basePath === undefined || headPath === undefined || outputPath === undefined) throw new Error('compare inputs are unavailable')
      return ['compare', 'architecture', basePath, headPath, outputPath, '--receipt', `${outputPath.slice(0, -5)}.receipt.json`, '--json']
    case 'inspect':
      if (inputPath === undefined) throw new Error('inspect input is unavailable')
      return ['inspect', 'architecture', inputPath]
    case 'guide':
      return ['guide', ...(args.scenario?.trim() ? [args.scenario.trim()] : []), '--json', ...(args.language ? ['--lang', args.language] : [])]
    case 'doctor':
      return ['doctor']
    case 'visual-check':
      if (outputPath === undefined) throw new Error('visual-check requires htmlPath')
      return ['visual-check', outputPath, '--json']
    case 'examples':
      return ['examples']
    case 'brands':
      return args.captureUrl?.trim()
        ? ['brands', 'capture', args.captureUrl.trim(), '--json']
        : ['brands', ...(args.query?.trim() ? [args.query.trim()] : []), '--json']
    case 'migrate': {
      if (requireType(command, args.type) !== 'workflow') throw new Error('migrate currently supports workflow only')
      if (inputPath === undefined || outputPath === undefined) throw new Error('migrate input is unavailable')
      return ['migrate', 'workflow', inputPath, outputPath, '--to-schema', args.migrateToSchema ?? '2', '--json']
    }
    default:
      throw new Error(`unsupported Archify action ${String(command)}`)
  }
}

function augmentCommand(args: string[], quality: ArchifyQuality | undefined, repoRoot: string | undefined): string[] {
  if (quality !== undefined) args.push('--quality', quality)
  if (repoRoot !== undefined) args.push('--repo-root', repoRoot)
  return args
}

async function runProcess(command: string[], options: CommandOptions): Promise<ProcessResult> {
  const executable = await options.subprocess.resolveExecutable(process.execPath, undefined, options.signal)
  const spec: SubprocessSpawnSpec = {
    argv: [executable, ARCHIFY_CLI, ...command],
    cwd: options.cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: options.maxCaptureBytes },
      stderr: { maxBytes: options.maxCaptureBytes },
    },
    graceMs: DEFAULT_GRACE_MS,
    signal: options.signal,
  }
  const handle = options.subprocess.spawn(spec)
  return new Promise((resolveResult, reject) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const append = (reader: typeof handle.collected.stdout): string => reader?.readFrom(0).text ?? ''
    const finish = (result: ProcessResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal.removeEventListener('abort', abort)
      resolveResult(result)
    }
    const abort = (): void => {
      handle.terminate()
    }
    const timer = setTimeout(() => {
      timedOut = true
      handle.terminate()
    }, options.timeoutMs)
    handle.done.then(
      outcome => {
        stdout = append(handle.collected.stdout)
        stderr = append(handle.collected.stderr)
        finish({ code: outcome.exitCode, signal: outcome.signal, stdout, stderr, timedOut })
      },
      error => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
    if (options.signal.aborted) abort()
    else options.signal.addEventListener('abort', abort, { once: true })
  })
}

async function writeInput(directory: string, name: string, value: JsonValue): Promise<{ path: string; bytes: Buffer; sha256: string }> {
  const bytes = canonicalJson(value)
  const path = join(directory, name)
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
  return { path, bytes, sha256: contentSha256(bytes) }
}

async function resolveHtmlPath(root: string, htmlPath: string | undefined): Promise<string | undefined> {
  if (htmlPath === undefined) return undefined
  const candidate = resolve(htmlPath)
  if (!isContainedPath(root, candidate)) throw new Error('htmlPath must point inside the Archify artifact root')
  const info = await stat(candidate)
  if (!info.isFile()) throw new Error('htmlPath must point to a regular file')
  return candidate
}

async function makeReceipt(root: string, data: Record<string, JsonValue>): Promise<`sha256:${string}`> {
  const receipt = await writeCas(root, canonicalJson(data))
  return receipt.ref
}

export type ArchifySubprocess = Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'>

function subprocessOf(exec: ToolRunContext, injected: ArchifySubprocess | undefined): ArchifySubprocess {
  const subprocess = injected ?? exec.agent?.ctx.subprocess
  if (subprocess === undefined) throw new Error('Archify requires the injected ctx.subprocess service')
  return subprocess
}

function baseReceipt(args: ArchifyToolArgs, type: ArchifyDiagramType | undefined): Record<string, JsonValue> {
  return {
    schemaVersion: 1,
    plugin: '@deepseek-ai/dsh-archify',
    action: args.action,
    ...(type === undefined ? {} : { type }),
    upstream: ARCHIFY_SOURCE,
  }
}

/** Execute one Archify operation without importing or mutating DSH control-plane state. */
export async function executeArchify(
  args: ArchifyToolArgs,
  exec: ToolRunContext,
  config: ArchifyConfig = {},
  injectedSubprocess?: ArchifySubprocess,
): Promise<ArchifyToolResult> {
  const subprocess = subprocessOf(exec, injectedSubprocess)
  const workspace = workspaceOf(exec)
  const root = artifactRootForWorkspace(workspace, config.artifactRoot)
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxCaptureBytes = config.maxCaptureBytes ?? DEFAULT_CAPTURE_BYTES
  const maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const type = args.type
  if (type !== undefined && !(ARCHIFY_DIAGRAM_TYPES as readonly string[]).includes(type)) throw new Error(`unsupported Archify diagram type ${type}`)
  if (!(ARCHIFY_ACTIONS as readonly string[]).includes(args.action)) throw new Error(`unsupported Archify action ${args.action}`)

  const temp = await mkdtemp(join(tmpdir(), 'dsh-archify-'))
  let inputHash: string | undefined
  let baseHash: string | undefined
  let headHash: string | undefined
  let commandResult: ProcessResult | undefined
  let parsed: JsonValue | undefined
  try {
    const input = ['render', 'validate', 'deliver', 'inspect', 'migrate'].includes(args.action)
      ? await writeInput(temp, 'input.json', requireInput(args.action, args.input))
      : undefined
    const base = args.action === 'compare'
      ? await writeInput(temp, 'base.json', requireInput(args.action, args.baseInput))
      : undefined
    const head = args.action === 'compare'
      ? await writeInput(temp, 'head.json', requireInput(args.action, args.headInput))
      : undefined
    inputHash = input?.sha256
    baseHash = base?.sha256
    headHash = head?.sha256

    const fileOutput = ['render', 'deliver', 'compare', 'migrate'].includes(args.action)
      ? join(temp, args.action === 'migrate' ? 'output.json' : 'output.html')
      : undefined
    const compareReceiptPath = args.action === 'compare' && fileOutput !== undefined
      ? `${fileOutput.slice(0, -5)}.receipt.json`
      : undefined
    const inspectedHtml = args.action === 'visual-check' ? await resolveHtmlPath(root, args.htmlPath) : undefined
    const inputPath = input?.path
    const command = commandFor(args, inputPath, base?.path, head?.path, inspectedHtml ?? fileOutput)
    augmentCommand(command, args.quality, args.repoRoot === undefined ? undefined : resolve(workspace, args.repoRoot))
    commandResult = await runProcess(command, { subprocess, cwd: temp, signal: exec.signal, timeoutMs, maxCaptureBytes })
    if (commandResult.code === 0 && fileOutput !== undefined) {
      const artifact = await readFile(fileOutput)
      if (artifact.byteLength > maxOutputBytes) throw new Error(`Archify output exceeds ${maxOutputBytes} bytes`)
      const artifactRef = await writeCas(root, artifact)
      let deliveryPath: string | undefined
      if (args.action === 'deliver' || args.action === 'migrate') {
        const outputName = safeName(args.outputName, `${type ?? 'diagram'}-${inputHash?.slice(0, 12) ?? 'artifact'}`)
        deliveryPath = await publishDelivery(root, args.action === 'migrate' ? outputName.replace(/\.html$/u, '.json') : outputName, artifact)
      }
      const upstreamReceipt = parseJson(commandResult.stdout)
      let upstreamReceiptRef
      if (compareReceiptPath !== undefined) {
        const upstreamReceiptBytes = await readFile(compareReceiptPath)
        if (upstreamReceiptBytes.byteLength > maxOutputBytes) throw new Error(`Archify receipt exceeds ${maxOutputBytes} bytes`)
        upstreamReceiptRef = await writeCas(root, upstreamReceiptBytes)
      }
      const receiptData = {
        ...baseReceipt(args, type),
        ok: true,
        inputs: { ...(inputHash === undefined ? {} : { inputSha256: inputHash }), ...(baseHash === undefined ? {} : { baseSha256: baseHash }), ...(headHash === undefined ? {} : { headSha256: headHash }) },
        command: { name: command[0], exitCode: commandResult.code, signal: commandResult.signal, timedOut: commandResult.timedOut, stdout: boundedText(commandResult.stdout, maxCaptureBytes), stderr: boundedText(commandResult.stderr, maxCaptureBytes) },
        artifact: { ref: artifactRef.ref, kind: args.action === 'migrate' ? 'json' : 'html', bytes: artifactRef.bytes, path: artifactRef.path },
        ...(deliveryPath === undefined ? {} : { deliveryPath }),
        ...(upstreamReceiptRef === undefined ? {} : {
          upstreamReceipt: { ref: upstreamReceiptRef.ref, kind: 'receipt', bytes: upstreamReceiptRef.bytes, path: upstreamReceiptRef.path },
        }),
      }
      const receiptRef = await makeReceipt(root, receiptData)
      return {
        schemaVersion: 1,
        ok: true,
        action: args.action,
        ...(type === undefined ? {} : { type }),
        upstream: ARCHIFY_SOURCE,
        summary: summaryOf(args.action, type, upstreamReceipt),
        artifactRef: { ref: artifactRef.ref, kind: args.action === 'migrate' ? 'json' : 'html', bytes: artifactRef.bytes, path: artifactRef.path },
        ...(deliveryPath === undefined ? {} : { deliveryPath }),
        ...(upstreamReceipt === undefined ? {} : { upstreamReceipt }),
        ...(upstreamReceiptRef === undefined ? {} : {
          upstreamReceiptRef: { ref: upstreamReceiptRef.ref, kind: 'receipt', bytes: upstreamReceiptRef.bytes, path: upstreamReceiptRef.path },
        }),
        receiptRef,
      }
    }

    parsed = parseJson(commandResult.stdout)
    const ok = commandResult.code === 0
    const errorMessage = ok ? undefined : (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && typeof parsed.error === 'string'
      ? parsed.error
      : commandResult.timedOut ? 'Archify command timed out.' : boundedText(commandResult.stderr || commandResult.stdout || 'Archify command failed.', maxCaptureBytes))
    const receiptData = {
      ...baseReceipt(args, type),
      ok,
      inputs: { ...(inputHash === undefined ? {} : { inputSha256: inputHash }), ...(baseHash === undefined ? {} : { baseSha256: baseHash }), ...(headHash === undefined ? {} : { headSha256: headHash }) },
      command: { name: command[0], exitCode: commandResult.code, signal: commandResult.signal, timedOut: commandResult.timedOut, stdout: boundedText(commandResult.stdout, maxCaptureBytes), stderr: boundedText(commandResult.stderr, maxCaptureBytes) },
      ...(parsed === undefined ? {} : { response: parsed }),
    }
    const receiptRef = await makeReceipt(root, receiptData)
    return {
      schemaVersion: 1,
      ok,
      action: args.action,
      ...(type === undefined ? {} : { type }),
      upstream: ARCHIFY_SOURCE,
      ...(ok ? { summary: summaryOf(args.action, type, parsed) } : {}),
      ...(diagnosticsOf(parsed) === undefined ? {} : { diagnostics: diagnosticsOf(parsed) }),
      receiptRef,
      ...(ok ? {} : { error: { code: commandResult.timedOut ? 'ARCHIFY_TIMEOUT' : 'ARCHIFY_COMMAND_FAILED', message: errorMessage ?? 'Archify command failed.', retryable: commandResult.timedOut } }),
    }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}
