/**
 * Built-in graders registered by every `ctx.benchmarks` registry:
 * `command-exit` (run a check command in the workspace), `file-contains`
 * (inspect one workspace file), and `session-event` (count tool calls in the
 * session log).
 * @module @deepseek-ai/dsh-bench/graders
 */

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, normalize, sep } from 'node:path'
import { z } from 'zod'
import type { BenchGrader, GradeInput, GradeResult, GraderSpec } from './types.ts'

const commandExitParams = z.object({
  kind: z.literal('command-exit'),
  command: z.array(z.string().min(1)).min(1),
  timeoutMs: z.number().int().positive(),
  expectExit: z.number().int().optional(),
}).strict()

const fileContainsParams = z.object({
  kind: z.literal('file-contains'),
  path: z.string().min(1),
  text: z.string().min(1),
}).strict()

const sessionEventParams = z.object({
  kind: z.literal('session-event'),
  tool: z.string().min(1),
  min: z.number().int().nonnegative().optional(),
  max: z.number().int().nonnegative().optional(),
}).strict().refine(spec => spec.min !== undefined || spec.max !== undefined, 'set min, max, or both')

/**
 * Parse a spec with `schema`, rethrowing failures with the grader kind named.
 * @param schema - the kind's parameter schema.
 * @param spec - the task's grader spec.
 * @returns the parsed parameters.
 */
function parse<T>(schema: z.ZodType<T>, spec: GraderSpec): T {
  const result = schema.safeParse(spec)
  if (!result.success) throw new Error(`invalid ${spec.kind} grader spec: ${z.prettifyError(result.error)}`)
  return result.data
}

/**
 * Resolve a task-relative path inside the workspace.
 * @param workspace - absolute workspace root.
 * @param path - relative path from the spec.
 * @returns the absolute path, or `undefined` when it would leave the workspace.
 */
function insideWorkspace(workspace: string, path: string): string | undefined {
  if (isAbsolute(path)) return undefined
  const relative = normalize(path)
  if (relative === '..' || relative.startsWith(`..${sep}`)) return undefined
  return join(workspace, relative)
}

/** Outcome of a check command: its exit code, or `null` when killed by the timeout or a signal. */
interface CommandOutcome {
  code: number | null
  output: string
}

/** Bytes of combined output kept for the verdict's details. */
const OUTPUT_TAIL_BYTES = 2000

/**
 * Run `argv` in `cwd` without a shell and capture its exit code and output tail.
 * @param argv - executable and arguments.
 * @param cwd - working directory.
 * @param timeoutMs - kill deadline.
 * @param signal - aborts the command.
 * @returns the exit outcome.
 */
function runCommand(argv: readonly string[], cwd: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<CommandOutcome> {
  return new Promise((resolve, reject) => {
    const [file, ...args] = argv as [string, ...string[]]
    const child = spawn(file, args, { cwd, timeout: timeoutMs, signal, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const collect = (chunk: Buffer): void => {
      output = (output + chunk.toString('utf8')).slice(-OUTPUT_TAIL_BYTES)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.once('error', (error) => {
      if (error.name === 'AbortError') resolve({ code: null, output })
      else reject(error)
    })
    child.once('close', (code) => {
      resolve({ code, output })
    })
  })
}

/** Passes when `command` exits with `expectExit` (default 0) before `timeoutMs`. */
export const commandExitGrader: BenchGrader = {
  kind: 'command-exit',
  version: 1,
  validate(spec) {
    parse(commandExitParams, spec)
  },
  async grade(spec, input: GradeInput): Promise<GradeResult> {
    const params = parse(commandExitParams, spec)
    const expected = params.expectExit ?? 0
    const outcome = await runCommand(params.command, input.workspace, params.timeoutMs, input.signal)
    const pass = outcome.code === expected
    const status = outcome.code === null ? 'was killed (timeout or signal)' : `exited ${String(outcome.code)}`
    return { pass, score: pass ? 1 : 0, details: `\`${params.command.join(' ')}\` ${status}, expected ${String(expected)}\n${outcome.output}` }
  },
}

/** Passes when the workspace file at `path` contains `text`. */
export const fileContainsGrader: BenchGrader = {
  kind: 'file-contains',
  version: 1,
  validate(spec) {
    const params = parse(fileContainsParams, spec)
    if (insideWorkspace('/', params.path) === undefined) throw new Error(`invalid file-contains grader spec: path ${JSON.stringify(params.path)} leaves the workspace`)
  },
  async grade(spec, input): Promise<GradeResult> {
    const params = parse(fileContainsParams, spec)
    const file = insideWorkspace(input.workspace, params.path) as string
    let content: string
    try {
      content = await readFile(file, 'utf8')
    } catch (error) {
      // A missing or unreadable file is the task's failure case, not a grader fault.
      return { pass: false, score: 0, details: `${params.path} is not readable: ${(error as Error).message}` }
    }
    const pass = content.includes(params.text)
    return { pass, score: pass ? 1 : 0, details: `${params.path} ${pass ? 'contains' : 'does not contain'} ${JSON.stringify(params.text)}` }
  },
}

/** Passes when the session log holds between `min` and `max` calls of `tool`. */
export const sessionEventGrader: BenchGrader = {
  kind: 'session-event',
  version: 1,
  validate(spec) {
    parse(sessionEventParams, spec)
  },
  grade(spec, input): Promise<GradeResult> {
    const params = parse(sessionEventParams, spec)
    let calls = 0
    for (const event of input.events) {
      if (event.type === 'tool/call' && event.data.name === params.tool) calls += 1
    }
    const pass = (params.min === undefined || calls >= params.min) && (params.max === undefined || calls <= params.max)
    const bounds = `[${params.min === undefined ? '-' : String(params.min)}, ${params.max === undefined ? '-' : String(params.max)}]`
    return Promise.resolve({ pass, score: pass ? 1 : 0, details: `${params.tool} called ${String(calls)} times, expected ${bounds}` })
  },
}

/** Graders every registry provides without a plugin registration. */
export const builtinGraders: readonly BenchGrader[] = [commandExitGrader, fileContainsGrader, sessionEventGrader]
