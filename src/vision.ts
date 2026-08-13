import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AttachmentStore, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ResolvedConfig } from './config.js'

/** Replaceable subprocess operation used by tests and alternative Luna launchers. */
export type VisionCommand = (
  command: string,
  imagePath: string,
  prompt: string,
  options: {
    timeoutMs: number
    maxOutputBytes: number
    codexCommand: string
    model: string
    signal?: AbortSignal
  },
) => Promise<string>

/** Dependencies required to materialize and transcribe a durable DSH image. */
export interface LunaVisionDeps {
  attachments: AttachmentStore
  config: ResolvedConfig
  runCommand?: VisionCommand
}

interface CachedDescription {
  version: 1
  description: string
}

function imageExtension(mediaType: ImageMediaType): string {
  switch (mediaType) {
    case 'image/png': return '.png'
    case 'image/jpeg': return '.jpg'
    case 'image/webp': return '.webp'
    case 'image/gif': return '.gif'
  }
}

function cacheKey(config: ResolvedConfig, ref: ImageAttachmentRef, prompt: string): string {
  return createHash('sha256')
    .update(config.cacheNamespace)
    .update('\0')
    .update(String(ref.attachmentId))
    .update('\0')
    .update(prompt)
    .digest('hex')
}

async function defaultVisionCommand(
  command: string,
  imagePath: string,
  prompt: string,
  options: {
    timeoutMs: number
    maxOutputBytes: number
    codexCommand: string
    model: string
    signal?: AbortSignal
  },
): Promise<string> {
  try {
    const output = await runCodex(command, [
      '--codex',
      options.codexCommand,
      '--model',
      options.model,
      imagePath,
      prompt,
    ], options)
    return parseCodexJsonl(output)
  } catch (error) {
    if (options.signal?.aborted === true) throw error
    if (error instanceof LlmError) throw error
    const detail = error instanceof Error ? error.message : String(error)
    throw new LlmError(`Luna image transcription failed: ${detail}`, 'LUNA_VISION_FAILED')
  }
}

function runCodex(
  command: string,
  args: readonly string[],
  options: { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeoutMs,
      windowsHide: true,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0
    let settled = false

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      reject(error)
    }
    const collect = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.byteLength
      if (outputBytes > options.maxOutputBytes) {
        child.kill()
        fail(new LlmError('Codex Luna output exceeded maxOutputBytes', 'LUNA_VISION_OUTPUT_TOO_LARGE'))
        return
      }
      target.push(chunk)
    }
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk))
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk))
    child.once('error', fail)
    child.once('close', (code, signal) => {
      if (settled) return
      if (code === 0) {
        settled = true
        resolve(Buffer.concat(stdout).toString('utf8'))
        return
      }
      const detail = Buffer.concat(stderr).toString('utf8').trim().slice(-4_000)
      fail(new LlmError(
        `Codex Luna exited with ${code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`}`
          + (detail === '' ? '' : `: ${detail}`),
        'LUNA_VISION_PROCESS_FAILED',
      ))
    })
  })
}

/**
 * Extract the last completed Codex agent message from `codex exec --json`.
 * @param output - JSONL written to stdout by Codex.
 * @returns the final assistant text.
 */
export function parseCodexJsonl(output: string): string {
  let finalText: string | undefined
  let failure: string | undefined
  for (const line of output.split(/\r?\n/u)) {
    if (line.trim() === '') continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event === null || typeof event !== 'object') continue
    const record = event as { type?: unknown; item?: unknown; error?: unknown }
    if (record.type === 'item.completed' && record.item !== null && typeof record.item === 'object') {
      const item = record.item as { type?: unknown; text?: unknown; message?: unknown }
      if (item.type === 'agent_message' && typeof item.text === 'string') finalText = item.text
      if (item.type === 'error' && typeof item.message === 'string') failure = item.message
    }
    if (record.type === 'turn.failed' && record.error !== null && typeof record.error === 'object') {
      const error = record.error as { message?: unknown }
      if (typeof error.message === 'string') failure = error.message
    }
  }
  if (finalText !== undefined) return finalText
  throw new LlmError(
    failure === undefined
      ? 'Codex Luna completed without an agent message'
      : `Codex Luna failed: ${failure}`,
    'LUNA_VISION_NO_MESSAGE',
  )
}

/** Content-addressed Luna runner over DSH's verified attachment store. */
export class LunaVision {
  private readonly descriptions = new Map<string, string>()
  private readonly pending = new Map<string, Promise<string>>()
  private readonly runCommand: VisionCommand

  /** @param deps - attachment, configuration, and optional subprocess dependencies. */
  constructor(private readonly deps: LunaVisionDeps) {
    this.runCommand = deps.runCommand ?? defaultVisionCommand
  }

  /**
   * Describe one durable image, coalescing duplicate work and using the private disk cache when enabled.
   * @param ref - verified DSH attachment reference.
   * @param prompt - complete Luna prompt, including bounded same-message text when configured.
   * @param signal - caller cancellation.
   * @returns Luna's non-empty visual transcription.
   */
  describe(ref: ImageAttachmentRef, prompt: string, signal?: AbortSignal): Promise<string> {
    const key = cacheKey(this.deps.config, ref, prompt)
    const memory = this.descriptions.get(key)
    if (memory !== undefined) return Promise.resolve(memory)
    const active = this.pending.get(key)
    if (active !== undefined) return active
    const task = this.describeUncached(key, ref, prompt, signal)
      .then((description) => {
        this.descriptions.set(key, description)
        return description
      })
      .finally(() => this.pending.delete(key))
    this.pending.set(key, task)
    return task
  }

  private async describeUncached(
    key: string,
    ref: ImageAttachmentRef,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const cached = await this.readCache(key)
    if (cached !== undefined) return cached
    const stored = await this.deps.attachments.readImage(ref)
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-luna-vision-bridge-'))
    await chmod(temporaryRoot, 0o700)
    const imagePath = join(temporaryRoot, `image${imageExtension(ref.mediaType)}`)
    try {
      await writeFile(imagePath, stored.data, { mode: 0o600 })
      const raw = await this.runCommand(
        this.deps.config.lunaCommand,
        imagePath,
        prompt,
        {
          timeoutMs: this.deps.config.timeoutMs,
          maxOutputBytes: this.deps.config.maxOutputBytes,
          codexCommand: this.deps.config.codexCommand,
          model: this.deps.config.lunaModel,
          ...(signal === undefined ? {} : { signal }),
        },
      )
      const description = raw.trim()
      if (description === '') {
        throw new LlmError('Luna image transcription returned an empty response', 'LUNA_VISION_EMPTY')
      }
      await this.writeCache(key, description)
      return description
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  }

  private async readCache(key: string): Promise<string | undefined> {
    if (!this.deps.config.cacheDescriptions) return undefined
    try {
      const raw = await readFile(join(this.deps.config.cacheDir, `${key}.json`), 'utf8')
      const value = JSON.parse(raw) as Partial<CachedDescription>
      return value.version === 1 && typeof value.description === 'string' && value.description.trim() !== ''
        ? value.description
        : undefined
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      return undefined
    }
  }

  private async writeCache(key: string, description: string): Promise<void> {
    if (!this.deps.config.cacheDescriptions) return
    await mkdir(this.deps.config.cacheDir, { recursive: true, mode: 0o700 })
    await chmod(this.deps.config.cacheDir, 0o700)
    const target = join(this.deps.config.cacheDir, `${key}.json`)
    const temporary = join(this.deps.config.cacheDir, `.${key}.${randomUUID()}.tmp`)
    const record: CachedDescription = { version: 1, description }
    try {
      await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'wx' })
      await rename(temporary, target)
    } finally {
      await rm(temporary, { force: true })
    }
  }
}
