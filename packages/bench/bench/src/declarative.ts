/**
 * Declarative suite format: a directory holding `suite.yml` (id, version,
 * description) and `tasks.jsonl` (one task per line), with task fixtures as
 * subdirectories. A suite package registers one with
 * `ctx.benchmarks.registerSuite(await loadDeclarativeSuite(dir))`.
 * @module @deepseek-ai/dsh-bench/declarative
 */

import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, normalize, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import type { BenchSuite, BenchSuiteId, BenchTask, BenchTaskId } from './types.ts'

/** File name of the suite header inside a declarative suite directory. */
export const SUITE_FILE = 'suite.yml'
/** File name of the task list inside a declarative suite directory. */
export const TASKS_FILE = 'tasks.jsonl'

const suiteHeader = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits, and dashes'),
  version: z.string().min(1),
  description: z.string().min(1),
}).strict()

const taskLine = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'letters, digits, dots, dashes, and underscores'),
  prompt: z.string().min(1),
  fixture: z.string().min(1).optional(),
  grader: z.looseObject({ kind: z.string().min(1) }),
  tags: z.array(z.string().min(1)).optional(),
}).strict()

/**
 * Resolve a suite-relative fixture path, refusing paths that leave the suite.
 * @param root - absolute suite directory.
 * @param fixture - path from the task line.
 * @param where - location for the error message.
 * @returns the absolute fixture directory.
 */
function fixturePath(root: string, fixture: string, where: string): string {
  const relative = normalize(fixture)
  if (isAbsolute(fixture) || relative === '..' || relative.startsWith(`..${sep}`)) {
    throw new Error(`${where}: fixture ${JSON.stringify(fixture)} must stay inside the suite directory`)
  }
  return join(root, relative)
}

/**
 * Parse `tasks.jsonl` text into tasks.
 * @param root - absolute suite directory, for fixture resolution.
 * @param text - the file content.
 * @param file - the file path, for error messages.
 * @returns the tasks in file order.
 */
async function parseTasks(root: string, text: string, file: string): Promise<BenchTask[]> {
  const tasks: BenchTask[] = []
  const seen = new Set<string>()
  const lines = text.split('\n')
  for (const [index, raw] of lines.entries()) {
    if (raw.trim() === '') continue
    const where = `${file}:${String(index + 1)}`
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch (error) {
      throw new Error(`${where}: not valid JSON: ${(error as Error).message}`, { cause: error })
    }
    const result = taskLine.safeParse(json)
    if (!result.success) throw new Error(`${where}: ${z.prettifyError(result.error)}`)
    const line = result.data
    if (seen.has(line.id)) throw new Error(`${where}: duplicate task id ${JSON.stringify(line.id)}`)
    seen.add(line.id)
    const task: BenchTask = {
      id: line.id as BenchTaskId,
      prompt: line.prompt,
      grader: line.grader,
      tags: line.tags ?? [],
    }
    if (line.fixture !== undefined) {
      const fixture = fixturePath(root, line.fixture, where)
      const info = await stat(fixture).catch(() => undefined)
      if (info?.isDirectory() !== true) throw new Error(`${where}: fixture ${JSON.stringify(line.fixture)} is not a directory`)
      task.fixture = fixture
    }
    tasks.push(task)
  }
  return tasks
}

/**
 * Read a declarative suite directory. The header is validated now; tasks are
 * read and validated on every `load()`, so edits to `tasks.jsonl` take effect
 * on the next experiment without reloading the plugin.
 * @param dir - absolute suite directory.
 * @returns the suite, ready to register.
 */
export async function loadDeclarativeSuite(dir: string): Promise<BenchSuite> {
  if (!isAbsolute(dir)) throw new Error(`declarative suite directory must be absolute: ${dir}`)
  const headerFile = join(dir, SUITE_FILE)
  const header = suiteHeader.safeParse(parseYaml(await readFile(headerFile, 'utf8')))
  if (!header.success) throw new Error(`${headerFile}: ${z.prettifyError(header.error)}`)
  const tasksFile = join(dir, TASKS_FILE)
  return {
    id: header.data.id as BenchSuiteId,
    version: header.data.version,
    description: header.data.description,
    async load(signal) {
      return parseTasks(dir, await readFile(tasksFile, { encoding: 'utf8', signal }), tasksFile)
    },
  }
}
