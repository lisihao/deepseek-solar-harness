import { execFileSync } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  accountAutonomousUsage,
  autonomousLimitReason,
  createAutonomousState,
  DEFAULT_AUTONOMOUS_LIMITS,
  evaluateAutonomousEndCondition,
  nextAutonomousDecision,
  resolveAutonomousPolicy,
} from '../src/autonomous.ts'

const cleanup: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true })
})

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    try {
      await access(path)
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  throw new Error(`timed out waiting for ${path}`)
}

async function gitWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-autonomous-'))
  cleanup.push(root)
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'DSH Test'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'dsh@example.invalid'], { cwd: root })
  await writeFile(join(root, 'tracked.txt'), 'initial\n')
  execFileSync('git', ['add', 'tracked.txt'], { cwd: root })
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root })
  return root
}

describe('Prime-compatible Autonomous host policy', () => {
  it('evaluates acceptance, artifact, and evaluator checks with explicit round status', async () => {
    const condition = {
      version: 1 as const,
      operator: 'all' as const,
      checks: [
        { id: 'acceptance', kind: 'acceptance' as const, ref: 'tests' },
        { id: 'artifact', kind: 'artifact-present' as const, ref: 'report' },
        { id: 'review', kind: 'evaluator' as const, ref: 'quality.review' },
      ],
    }
    const evaluatorRounds: number[] = []
    const passed = await evaluateAutonomousEndCondition(condition, {
      acceptance: { tests: 'pass' },
      artifacts: { report: 'pass' },
    }, 2, {
      'quality.review': ({ round }) => {
        evaluatorRounds.push(round)
        return 'pass'
      },
    })
    expect(passed).toMatchObject({ version: 1, round: 2, status: 'pass', reason: 'all_checks_passed' })
    expect(passed.checks.map(check => check.status)).toEqual(['pass', 'pass', 'pass'])
    expect(evaluatorRounds).toEqual([2])

    await expect(evaluateAutonomousEndCondition(condition, {
      acceptance: { tests: 'fail' },
      artifacts: { report: 'pass' },
      evaluators: { 'quality.review': 'pass' },
    }, 3)).resolves.toMatchObject({ status: 'fail', reason: 'one_or_more_checks_failed', round: 3 })

    await expect(evaluateAutonomousEndCondition(condition, {
      acceptance: { tests: 'pass' },
      artifacts: { report: 'pass' },
    }, 4)).resolves.toMatchObject({ status: 'unknown', reason: 'one_or_more_checks_unknown', round: 4 })
  })

  it('supports any conditions without allowing an unknown result to pass', async () => {
    const condition = {
      version: 1 as const,
      operator: 'any' as const,
      checks: [
        { id: 'first', kind: 'evaluator' as const, ref: 'first' },
        { id: 'second', kind: 'evaluator' as const, ref: 'second' },
      ],
    }
    await expect(evaluateAutonomousEndCondition(condition, { evaluators: { first: 'fail', second: 'unknown' } }))
      .resolves.toMatchObject({ status: 'unknown' })
    await expect(evaluateAutonomousEndCondition(condition, { evaluators: { first: 'fail', second: 'fail' } }))
      .resolves.toMatchObject({ status: 'fail' })
  })

  it('fails closed for invalid condition versions, check limits, and evaluator results', async () => {
    const check = { id: 'done', kind: 'evaluator' as const, ref: 'done' }
    await expect(evaluateAutonomousEndCondition({ version: 2 as 1, operator: 'all', checks: [check] }, {}))
      .rejects.toThrow('version must be 1')
    await expect(evaluateAutonomousEndCondition({
      version: 1,
      operator: 'all',
      checks: Array.from({ length: 17 }, (_, index) => ({ ...check, id: `done-${String(index)}` })),
    }, {})).rejects.toThrow('1 through 16')
    await expect(evaluateAutonomousEndCondition({ version: 1, operator: 'all', checks: [check] }, {}, 1, {
      done: () => 'invalid' as never,
    })).rejects.toThrow('invalid status')
  })

  it('uses a task-specific condition as the only successful terminal evidence', async () => {
    const policy = resolveAutonomousPolicy({
      mode: 'enabled',
      endCondition: {
        version: 1,
        operator: 'all',
        checks: [{ id: 'done', kind: 'acceptance', ref: 'done' }],
      },
    }, undefined, true)
    const initial = createAutonomousState(policy)
    const failed = await nextAutonomousDecision(policy, initial, await gitWorkspace(), undefined, new Date(), {
      acceptance: { done: 'fail' },
    })
    expect(failed).toMatchObject({ action: 'continue', reason: 'end_condition_failed' })
    if (failed.action !== 'continue') throw new Error('expected continuation')
    const unknownAtLimit = await nextAutonomousDecision(policy, {
      ...failed.state,
      continuationsUsed: policy.maxContinuations,
    }, await gitWorkspace(), undefined, new Date(), {
      acceptance: { done: 'unknown' },
    })
    expect(unknownAtLimit).toMatchObject({ action: 'complete', reason: 'maxContinuations' })
    if (unknownAtLimit.action !== 'complete') throw new Error('expected terminal limit')
    expect(unknownAtLimit.state.lastEndCondition?.status).toBe('unknown')

    const passed = await nextAutonomousDecision(policy, initial, await gitWorkspace(), undefined, new Date(), {
      acceptance: { done: 'pass' },
    })
    expect(passed).toMatchObject({ action: 'complete', reason: 'end_condition_passed' })
  })

  it('keeps the end-condition round result stable across durable JSON restart', async () => {
    const policy = resolveAutonomousPolicy({
      mode: 'enabled',
      endCondition: {
        version: 1,
        operator: 'all',
        checks: [{ id: 'done', kind: 'acceptance', ref: 'done' }],
      },
    }, undefined, true)
    const workspace = await gitWorkspace()
    const first = await nextAutonomousDecision(policy, createAutonomousState(policy), workspace, undefined, new Date('2026-08-27T01:00:00.000Z'), {
      acceptance: { done: 'unknown' },
    })
    if (first.action !== 'continue') throw new Error('expected continuation')
    const restored = JSON.parse(JSON.stringify(first.state)) as typeof first.state
    expect(restored.lastEndCondition).toEqual(first.state.lastEndCondition)
    expect(restored.lastEndCondition?.status).toBe('unknown')
    expect(policy.policySha256).toBe(resolveAutonomousPolicy({
      mode: 'enabled',
      ...(policy.endCondition === undefined ? {} : { endCondition: policy.endCondition }),
    }, undefined, true).policySha256)
  })

  it('seals official defaults and counts cache-write but not cache-read tokens', () => {
    const policy = resolveAutonomousPolicy({ mode: 'enabled' }, undefined, true)
    expect(policy).toMatchObject({
      enabled: true,
      maxContinuations: DEFAULT_AUTONOMOUS_LIMITS.maxContinuations,
      maxTurns: DEFAULT_AUTONOMOUS_LIMITS.maxTurns,
      maxTokens: DEFAULT_AUTONOMOUS_LIMITS.maxTokens,
      timeoutMs: DEFAULT_AUTONOMOUS_LIMITS.timeoutMs,
      gates: {
        maxRetries: DEFAULT_AUTONOMOUS_LIMITS.gateMaxRetries,
        timeoutMs: DEFAULT_AUTONOMOUS_LIMITS.gateTimeoutMs,
      },
    })
    const initial = createAutonomousState(policy, new Date('2026-08-27T00:00:00.000Z'))
    const counted = accountAutonomousUsage(initial, 'root', {
      inputTokens: 3,
      outputTokens: 2,
      cacheReadInputTokens: 100,
      cacheWriteInputTokens: 4,
    })
    expect(counted).toMatchObject({ turnsUsed: 1, tokensUsed: 9, accountedCommandIds: ['root'] })
    expect(accountAutonomousUsage(counted, 'root', { inputTokens: 50, outputTokens: 50 })).toBe(counted)
  })

  it('evaluates a passing quality gate before exhausted limits', async () => {
    const workspace = await gitWorkspace()
    const policy = resolveAutonomousPolicy({
      mode: 'enabled',
      maxTurns: 1,
      gates: { commands: [`${process.execPath} -e "process.exit(0)"`] },
    }, undefined, true)
    const state = accountAutonomousUsage(createAutonomousState(policy), 'root', { inputTokens: 1, outputTokens: 1 })
    expect(autonomousLimitReason(policy, state)).toBe('maxTurns')
    await expect(nextAutonomousDecision(policy, state, workspace)).resolves.toMatchObject({
      action: 'complete',
      reason: 'gate_passed',
    })
  })

  it('does not rerun an unchanged failed gate and advances the retry budget', async () => {
    const workspace = await gitWorkspace()
    const counter = join(workspace, '.counter')
    const gate = `${process.execPath} -e "const fs=require('fs');fs.appendFileSync('.counter','run\\n');process.exit(1)"`
    const policy = resolveAutonomousPolicy({
      mode: 'enabled',
      maxContinuations: 4,
      gates: { commands: [gate], maxRetries: 3 },
    }, undefined, true)
    const first = await nextAutonomousDecision(policy, createAutonomousState(policy), workspace)
    expect(first).toMatchObject({ action: 'continue', reason: 'gate_failed' })
    if (first.action !== 'continue') throw new Error('expected first continuation')
    const second = await nextAutonomousDecision(policy, first.state, workspace)
    expect(second).toMatchObject({ action: 'continue', reason: 'gate_failed' })
    if (second.action !== 'continue') throw new Error('expected second continuation')
    expect(second.prompt).toContain('workspace has not changed')
    expect(await readFile(counter, 'utf8')).toBe('run\n')
    expect(second.state.gateAttempts[gate]).toBe(2)
  })

  it('uses the official limit order and never upgrades a limit to success', async () => {
    const workspace = await gitWorkspace()
    const policy = resolveAutonomousPolicy({
      mode: 'enabled', maxContinuations: 1, maxTurns: 1, maxTokens: 1, timeoutMs: 1,
    }, undefined, true)
    const state = {
      ...createAutonomousState(policy, new Date('2026-08-27T00:00:00.000Z')),
      continuationsUsed: 1,
      turnsUsed: 1,
      tokensUsed: 1,
    }
    expect(autonomousLimitReason(policy, state, new Date('2026-08-27T01:00:00.000Z'))).toBe('maxContinuations')
    await expect(nextAutonomousDecision(policy, state, workspace, undefined, new Date('2026-08-27T01:00:00.000Z')))
      .resolves.toMatchObject({ action: 'complete', reason: 'maxContinuations' })
  })

  it('stops after the configured gate retry budget without rerunning unchanged work', async () => {
    const workspace = await gitWorkspace()
    const policy = resolveAutonomousPolicy({
      mode: 'enabled',
      maxContinuations: 5,
      gates: { commands: [`${process.execPath} -e "process.exit(1)"`], maxRetries: 1 },
    }, undefined, true)
    const first = await nextAutonomousDecision(policy, createAutonomousState(policy), workspace)
    expect(first).toMatchObject({ action: 'continue', reason: 'gate_failed' })
    const second = await nextAutonomousDecision(policy, first.state, workspace)
    expect(second).toMatchObject({ action: 'complete', reason: 'gate_retry_exhausted' })
  })

  it('runs gates with the shared credential-scrubbed child environment', async () => {
    const workspace = await gitWorkspace()
    vi.stubEnv('AUTONOMOUS_TEST_SECRET_TOKEN', 'must-not-leak')
    const policy = resolveAutonomousPolicy({
      mode: 'enabled',
      gates: { commands: [`${process.execPath} -e "process.exit(process.env.AUTONOMOUS_TEST_SECRET_TOKEN===undefined?0:1)"`] },
    }, undefined, true)
    await expect(nextAutonomousDecision(policy, createAutonomousState(policy), workspace)).resolves.toMatchObject({
      action: 'complete',
      reason: 'gate_passed',
    })
  })

  it('waits for an aborted gate process tree to exit before rejecting', async () => {
    const workspace = await gitWorkspace()
    const pidFile = join(workspace, '.gate-pid')
    const controller = new AbortController()
    const gateScript = "require('fs').writeFileSync('.gate-pid',String(process.pid));setInterval(()=>{},1000)"
    const policy = resolveAutonomousPolicy({
      mode: 'enabled',
      gates: {
        commands: [`${process.execPath} -e ${JSON.stringify(gateScript)}`],
      },
    }, undefined, true)
    const decision = nextAutonomousDecision(policy, createAutonomousState(policy), workspace, controller.signal)
    await waitForFile(pidFile)
    const pid = Number(await readFile(pidFile, 'utf8'))
    controller.abort(new Error('test abort'))
    await expect(decision).rejects.toThrow('test abort')
    expect(() => process.kill(pid, 0)).toThrow()
  })
})
