/**
 * Conformance kit for benchmark suites. A suite package's test calls
 * {@link describeSuiteConformance} with one passing and one failing run per
 * task; the kit checks that the suite loads, every fixture exists, every
 * grader spec is registered and valid, and each grader tells the passing run
 * from the failing one, so a suite cannot ship a grader that passes
 * everything.
 *
 * Test helper ported from DSH 3.x bench-testkit.
 */

import { cp, mkdtemp, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { builtinGraders } from '../src/index.js'
import type { BenchGrader, BenchSuite, BenchTask } from '../src/index.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'

/** A simulated finished run: workspace files over the task fixture, and a session log. */
export interface ConformanceRun {
  /** Workspace-relative path → content, written over the fixture copy. */
  files?: Readonly<Record<string, string>>
  /** The session log the grader sees. */
  events?: readonly SessionEvent[]
}

/** Options of a conformance check. */
export interface SuiteConformanceOptions {
  /** The suite under test. */
  suite: BenchSuite
  /** Graders the suite package registers besides the built-in ones. */
  graders?: readonly BenchGrader[]
  /** Per task id: a run its grader must pass and one it must fail. */
  runs: Readonly<Record<string, { pass: ConformanceRun; fail: ConformanceRun }>>
}

/**
 * Grade one simulated run in a scratch workspace.
 * @param task - the task.
 * @param grader - its grader.
 * @param run - the simulated run.
 * @returns whether the grader passed it.
 */
async function gradeRun(task: BenchTask, grader: BenchGrader, run: ConformanceRun): Promise<boolean> {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-bench-conformance-'))
  try {
    if (task.fixture !== undefined) await cp(task.fixture, workspace, { recursive: true })
    for (const [path, content] of Object.entries(run.files ?? {})) {
      await mkdir(dirname(join(workspace, path)), { recursive: true })
      await writeFile(join(workspace, path), content)
    }
    return (await grader.grade(task.grader, { workspace, events: run.events ?? [] })).pass
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

/**
 * Check a suite and collect every violation.
 * @param options - the suite, its extra graders, and the per-task runs.
 * @returns one message per violation; empty when the suite conforms.
 */
export async function checkSuiteConformance(options: SuiteConformanceOptions): Promise<string[]> {
  const problems: string[] = []
  const graders = new Map<string, BenchGrader>([...builtinGraders, ...options.graders ?? []].map(grader => [grader.kind, grader]))
  let tasks: readonly BenchTask[]
  try {
    tasks = await options.suite.load()
  } catch (error) {
    return [`suite ${options.suite.id} fails to load: ${(error as Error).message}`]
  }
  if (tasks.length === 0) problems.push(`suite ${options.suite.id} has no tasks`)
  const ids = new Set<string>()
  for (const task of tasks) {
    if (ids.has(task.id)) problems.push(`task ${task.id}: duplicate id`)
    ids.add(task.id)
    if (task.fixture !== undefined && (await stat(task.fixture).catch(() => undefined))?.isDirectory() !== true) {
      problems.push(`task ${task.id}: fixture ${task.fixture} is not a directory`)
      continue
    }
    const grader = graders.get(task.grader.kind)
    if (grader === undefined) {
      problems.push(`task ${task.id}: grader ${task.grader.kind} is not registered`)
      continue
    }
    try {
      grader.validate(task.grader)
    } catch (error) {
      problems.push(`task ${task.id}: ${(error as Error).message}`)
      continue
    }
    const runs = options.runs[task.id]
    if (runs === undefined) {
      problems.push(`task ${task.id}: no pass/fail runs given`)
      continue
    }
    if (!await gradeRun(task, grader, runs.pass)) problems.push(`task ${task.id}: grader fails the passing run`)
    if (await gradeRun(task, grader, runs.fail)) problems.push(`task ${task.id}: grader passes the failing run`)
  }
  for (const id of Object.keys(options.runs)) if (!ids.has(id)) problems.push(`runs given for unknown task ${id}`)
  return problems
}

/**
 * Register a vitest case asserting that a suite conforms.
 * @param options - the suite, its extra graders, and the per-task runs.
 */
export function describeSuiteConformance(options: SuiteConformanceOptions): void {
  it(`benchmark suite ${options.suite.id} conforms`, async () => {
    expect(await checkSuiteConformance(options)).toEqual([])
  })
}
