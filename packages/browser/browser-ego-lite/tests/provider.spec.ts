import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import BrowserRuntime, {
  BrowserError,
  BrowserOperationId,
  BrowserPageKey,
  BrowserWorkspaceId,
  type BrowserRunPlanV1,
  type BrowserRunProgramV1,
} from '@deepseek-ai/dsh-browser'
import {
  SubprocessRuntime,
  type SubprocessHandle,
  type SubprocessOutcome,
  type SubprocessOutputRead,
  type SubprocessOutputReader,
  type SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it } from 'vitest'
import * as EgoLite from '../src/index.ts'

interface ScriptedRun {
  readonly outcome: SubprocessOutcome
  readonly stdout?: string
  readonly stderr?: string
  readonly stdoutLossy?: boolean
  readonly stderrLossy?: boolean
}

class DeferredReader implements SubprocessOutputReader {
  run: ScriptedRun | undefined

  constructor(private readonly channel: 'stdout' | 'stderr') {}

  readFrom(_fromByte: number): SubprocessOutputRead {
    const run = this.run
    if (run === undefined) throw new Error('fixture subprocess has not settled')
    const text = run[this.channel] ?? ''
    return {
      text,
      nextOffset: Buffer.byteLength(text),
      lossy: run[this.channel === 'stdout' ? 'stdoutLossy' : 'stderrLossy'] ?? false,
    }
  }
}

class FakeHandle implements SubprocessHandle {
  readonly pid = 42
  readonly stdin = undefined
  readonly stdout = undefined
  readonly stderr = undefined
  readonly collected
  readonly done: Promise<SubprocessOutcome>
  terminated = false
  private readonly stdoutReader = new DeferredReader('stdout')
  private readonly stderrReader = new DeferredReader('stderr')

  constructor(run: Promise<ScriptedRun>, collect = true) {
    this.collected = collect ? { stdout: this.stdoutReader, stderr: this.stderrReader } : {}
    this.done = run.then((result) => {
      this.stdoutReader.run = result
      this.stderrReader.run = result
      return result.outcome
    })
  }

  terminate(): void {
    this.terminated = true
  }

  waitForExit(): Promise<boolean> {
    return Promise.resolve(true)
  }
}

class FakeSubprocess extends SubprocessRuntime {
  readonly resolutions: string[] = []
  readonly spawns: SubprocessSpawnSpec[] = []
  resolve: (command: string) => Promise<string> = command => Promise.resolve(command)
  run: (spec: SubprocessSpawnSpec) => Promise<ScriptedRun> = () => Promise.resolve(successFrame(planResult))
  spawnError: Error | undefined
  doneError: Error | undefined
  dropReaders = false
  beforeSpawn: (() => void) | undefined

  override resolveExecutable(command: string): Promise<string> {
    this.resolutions.push(command)
    return this.resolve(command)
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.spawns.push(spec)
    this.beforeSpawn?.()
    if (this.spawnError !== undefined) throw this.spawnError
    if (this.doneError !== undefined) {
      const handle = new FakeHandle(Promise.resolve(successFrame(planResult)))
      Object.defineProperty(handle, 'done', { value: Promise.reject(this.doneError) })
      return handle
    }
    return new FakeHandle(this.run(spec), !this.dropReaders)
  }

  override spawnTerminal(): Promise<never> {
    throw new Error('browser-ego-lite never allocates a terminal')
  }
}

const op = (value: string) => BrowserOperationId(value)
const pageKey = (value: string) => BrowserPageKey(value)

const plan: BrowserRunPlanV1 = {
  version: 1,
  workspace: { kind: 'named', name: 'workspace', createIfMissing: true },
  requiredCapabilities: ['named-workspace'],
  operations: [{
    kind: 'open',
    id: op('open-main'),
    page: pageKey('main'),
    url: 'https://example.com',
    reuse: 'exact-url',
    waitUntil: 'load',
  }],
}

const planResult = {
  version: 1,
  workspace: {
    id: 'ego-lite:7',
    name: 'workspace',
    lifecycle: 'active',
    control: 'agent',
  },
  operations: [{
    kind: 'page',
    id: 'open-main',
    operation: 'open',
    page: { page: 'main', url: 'https://example.com', title: 'Example' },
  }],
}

const program: BrowserRunProgramV1 = {
  version: 1,
  language: 'browser-js-v1',
  workspace: { kind: 'named', name: 'workspace', createIfMissing: true },
  source: 'return "ok"',
  requiredCapabilities: [],
  output: { kind: 'text', maxCharacters: 8 },
}

function successFrame(result: unknown, notice = false): ScriptedRun {
  const suffix = notice ? '\n[ego-browser:notice] ego lite 1.3.0 is available' : ''
  return {
    outcome: { exitCode: 0, signal: null },
    stdout: `${EgoLite.EGO_LITE_FRAME_PREFIX}${JSON.stringify({ ok: true, result })}${suffix}\n`,
  }
}

function errorFrame(error: Record<string, unknown>, exitCode = 1): ScriptedRun {
  return {
    outcome: { exitCode, signal: null },
    stderr: `${EgoLite.EGO_LITE_FRAME_PREFIX}${JSON.stringify({ ok: false, error })}\nfixture stack\n`,
  }
}

async function setup(config: EgoLite.Config = { executable: '/Applications/ego-browser' }) {
  const ctx = new Context()
  const notices: string[] = []
  ctx.logger.info = ((message: unknown) => { notices.push(String(message)) }) as typeof ctx.logger.info
  await ctx.plugin(BrowserRuntime)
  await ctx.plugin(FakeSubprocess)
  const subprocess = ctx.subprocess as FakeSubprocess
  await ctx.plugin(EgoLite, config)
  return { ctx, subprocess, notices }
}

interface FixtureState {
  snapshotCalls: number
  takeoverCalls: number
}

async function executeFixtureSource(source: string, state: FixtureState = { snapshotCalls: 0, takeoverCalls: 0 }): Promise<ScriptedRun> {
  const target = globalThis as Record<string, unknown>
  const previous = new Map<string, unknown>()
  const names = ['browser', 'page', 'taskSpaces'] as const
  for (const name of names) previous.set(name, target[name])
  const originalConsole = globalThis.console
  const stdout: string[] = []
  const stderr: string[] = []
  const tasks = [
    { id: 7, name: 'workspace', ownership: 'agent' },
    { id: 8, name: 'user-space', ownership: 'user' },
  ]
  const tabs: { targetId: string; url: string; title: string; active: boolean }[] = []
  let active: (typeof tabs)[number] | undefined

  const locator = () => ({
    click: () => Promise.resolve(),
    fill: () => Promise.resolve(),
    clear: () => Promise.resolve(),
    press: () => Promise.resolve(),
    setChecked: () => Promise.resolve(),
    selectOption: () => Promise.resolve([]),
    innerText: () => Promise.resolve('fixture text'),
    inputValue: () => Promise.resolve('fixture value'),
    innerHTML: () => Promise.resolve('<p>fixture</p>'),
    getAttribute: (name: string) => Promise.resolve(name === 'data-id' ? 'fixture-id' : null),
    count: () => Promise.resolve(1),
    isHidden: () => Promise.resolve(false),
    waitFor: () => Promise.resolve(true),
    nth: () => locator(),
  })
  target.browser = {
    openOrReuseTab: async (url: string) => {
      const existing = tabs.find(tab => tab.url === url)
      if (existing !== undefined) {
        active = existing
        return { ...existing, reused: true }
      }
      const created = { targetId: `target-${tabs.length + 1}`, url, title: 'Fixture', active: true }
      tabs.push(created)
      active = created
      return { ...created, reused: false }
    },
    listTabs: () => Promise.resolve(tabs),
    switchTab: async (targetId: string) => {
      const found = tabs.find(tab => tab.targetId === targetId)
      if (found === undefined) throw new Error('target missing')
      active = found
      return targetId
    },
    closeTab: async (targetId: string) => {
      const index = tabs.findIndex(tab => tab.targetId === targetId)
      if (index < 0) throw new Error('target missing')
      tabs.splice(index, 1)
      active = tabs[0]
      return targetId
    },
  }
  target.page = {
    info: () => Promise.resolve({ url: active?.url ?? 'about:blank', title: active?.title ?? '' }),
    goto: async (url: string) => {
      if (active !== undefined) active.url = url
      return { loaded: true }
    },
    reload: () => Promise.resolve(true),
    snapshot: async () => {
      state.snapshotCalls += 1
      if (active?.url === 'https://user-control.example') {
        const error = new Error('native user-control text') as Error & { error_code: string }
        error.error_code = 'EGO_TASK_SPACE_USER_IN_CONTROL'
        throw error
      }
      return 'fixture snapshot'
    },
    screenshot: async () => {
      const path = join(tmpdir(), `dsh-ego-lite-fixture-${process.pid}-${Date.now()}.png`)
      await writeFile(path, Buffer.from([1, 2, 3]))
      return path
    },
    locator,
    getByRole: locator,
    getByText: locator,
    getByLabel: locator,
    getByPlaceholder: locator,
    getByTestId: locator,
    waitForLoadState: () => Promise.resolve(true),
    waitForURL: () => Promise.resolve(true),
    waitForTimeout: () => Promise.resolve(),
    evaluate: (expression: string) => Promise.resolve((0, eval)(expression)),
  }
  target.taskSpaces = {
    list: () => Promise.resolve(tasks),
    useOrCreate: async (nameOrId: string | number) => {
      const found = tasks.find(task => task.id === nameOrId || task.name === nameOrId)
      if (found !== undefined) return found
      const created = { id: tasks.length + 7, name: String(nameOrId), ownership: 'agent' }
      tasks.push(created)
      return created
    },
    handOff: async (id: number) => {
      const task = tasks.find(entry => entry.id === id)
      if (task !== undefined) task.ownership = 'user'
      return { done: true }
    },
    takeOver: async (id: number) => {
      state.takeoverCalls += 1
      const task = tasks.find(entry => entry.id === id)
      if (task !== undefined) task.ownership = 'agent'
    },
    waitForAgentControl: () => Promise.resolve(),
    complete: () => Promise.resolve({ done: true }),
  }
  globalThis.console = {
    ...originalConsole,
    log: (...args: unknown[]) => { stdout.push(args.map(String).join(' ')) },
    error: (...args: unknown[]) => { stderr.push(args.map(String).join(' ')) },
  }
  let outcome: SubprocessOutcome = { exitCode: 0, signal: null }
  try {
    const AsyncFunction = (async function () {}).constructor as unknown as new (source: string) => () => Promise<void>
    await new AsyncFunction(source)()
  } catch (error) {
    outcome = { exitCode: 1, signal: null }
    stderr.push(error instanceof Error ? error.stack ?? error.message : String(error))
  } finally {
    stdout.push('[ego-browser:notice] ego lite 1.3.0 is available')
    globalThis.console = originalConsole
    for (const name of names) {
      const value = previous.get(name)
      if (value === undefined) Reflect.deleteProperty(target, name)
      else target[name] = value
    }
  }
  return { outcome, stdout: `${stdout.join('\n')}\n`, stderr: `${stderr.join('\n')}\n` }
}

describe('EgoLiteBrowserProvider process protocol', () => {
  it('spawns exactly [executable, nodejs] without a shell and sends one complete stdin program', async () => {
    const { ctx, subprocess } = await setup()

    await expect(ctx.browser.runPlan(plan)).resolves.toMatchObject({ version: 1 })

    expect(subprocess.spawns).toHaveLength(1)
    const [spawn] = subprocess.spawns
    expect(spawn?.argv).toEqual(['/Applications/ego-browser', 'nodejs'])
    expect(spawn?.cwd).toBe(process.cwd())
    const stdin = spawn?.stdio.stdin
    expect(typeof stdin).toBe('object')
    expect(typeof stdin === 'object' && 'data' in stdin ? stdin.data : '').toContain('await __dshEntrypoint')
    expect(spawn?.signal).toBeUndefined()
  })

  it('uses JSON string embedding so quotes, backticks, interpolation text, and newlines stay data', async () => {
    const marker = 'quote:" backtick:` interpolation:${notCode}\nline-two'
    const escapedProgram: BrowserRunProgramV1 = {
      ...program,
      source: `return ${JSON.stringify(marker)}`,
      output: { kind: 'text', maxCharacters: 200 },
    }
    const { ctx, subprocess } = await setup()
    subprocess.run = spec => executeFixtureSource((spec.stdio.stdin as { data: string }).data)

    await expect(ctx.browser.runProgram(escapedProgram)).resolves.toMatchObject({
      output: { kind: 'text', value: marker, truncated: false },
    })
    expect(subprocess.spawns).toHaveLength(1)
  })

  it('executes a composite plan while keeping native target ids inside one heredoc', async () => {
    const composite: BrowserRunPlanV1 = {
      ...plan,
      operations: [
        plan.operations[0]!,
        { kind: 'navigate', id: op('navigate'), page: pageKey('main'), url: 'https://next.example', waitUntil: 'network-idle' },
        { kind: 'snapshot', id: op('snapshot'), page: pageKey('main') },
        { kind: 'read', id: op('read'), page: pageKey('main'), locator: { kind: 'role', role: 'heading', index: 0 }, target: { kind: 'text' } },
        { kind: 'count', id: op('count'), page: pageKey('main'), locator: { kind: 'css', selector: 'article' } },
        { kind: 'screenshot', id: op('shot'), page: pageKey('main'), fullPage: true },
        { kind: 'complete', id: op('complete'), keep: false },
      ],
    }
    const { ctx, subprocess, notices } = await setup()
    subprocess.run = spec => executeFixtureSource((spec.stdio.stdin as { data: string }).data)

    const result = await ctx.browser.runPlan(composite)

    expect(result.operations).toHaveLength(7)
    expect(result.operations[1]).toMatchObject({ kind: 'page', page: { url: 'https://next.example' } })
    expect(result.operations[2]).toMatchObject({ kind: 'snapshot', content: 'fixture snapshot' })
    expect(result.operations[5]).toMatchObject({ kind: 'screenshot', bytes: Uint8Array.from([1, 2, 3]) })
    expect(JSON.stringify(result)).not.toContain('target-')
    expect(notices).toEqual(['browser-ego-lite: [ego-browser:notice] ego lite 1.3.0 is available'])
  })

  it('maps stable Ego user-control and inactive codes to hard-stop browser errors', async () => {
    const a = await setup()
    a.subprocess.run = () => Promise.resolve(errorFrame({ message: 'user controls it', error_code: 'EGO_TASK_SPACE_USER_IN_CONTROL' }))
    await expect(a.ctx.browser.runPlan(plan)).rejects.toMatchObject({ code: 'BROWSER_USER_CONTROL' })

    const b = await setup()
    b.subprocess.run = () => Promise.resolve(errorFrame({ message: 'inactive', error_code: 'EGO_TASK_SPACE_INACTIVE' }))
    await expect(b.ctx.browser.runPlan(plan)).rejects.toMatchObject({ code: 'BROWSER_WORKSPACE_INACTIVE' })
  })

  it('hard-stops a swallowed native error and never retries the browser call or process', async () => {
    const state = { snapshotCalls: 0, takeoverCalls: 0 }
    const hardStopProgram: BrowserRunProgramV1 = {
      ...program,
      source: `
        await browser.run({kind:"open",id:"open",page:"main",url:"https://user-control.example",reuse:"exact-url",waitUntil:"load"});
        try { await browser.run({kind:"snapshot",id:"first",page:"main"}); } catch {}
        try { await browser.run({kind:"snapshot",id:"second",page:"main"}); } catch {}
        return "must not succeed";
      `,
      output: { kind: 'text', maxCharacters: 100 },
    }
    const { ctx, subprocess } = await setup()
    subprocess.run = spec => executeFixtureSource((spec.stdio.stdin as { data: string }).data, state)

    await expect(ctx.browser.runProgram(hardStopProgram)).rejects.toMatchObject({
      code: 'BROWSER_USER_CONTROL',
      operationId: op('first'),
    })
    expect(state.snapshotCalls).toBe(1)
    expect(state.takeoverCalls).toBe(0)
    expect(subprocess.spawns).toHaveLength(1)
  })

  it('forwards AbortSignal and reports cancellation without another spawn', async () => {
    const { ctx, subprocess } = await setup()
    const controller = new AbortController()
    subprocess.run = spec => new Promise((resolve) => {
      spec.signal?.addEventListener('abort', () => {
        resolve({ outcome: { exitCode: null, signal: 'SIGTERM' } })
      }, { once: true })
    })

    const pending = ctx.browser.runPlan(plan, controller.signal)
    controller.abort(new Error('stop'))

    await expect(pending).rejects.toMatchObject({ code: 'BROWSER_ABORTED' })
    expect(subprocess.spawns).toHaveLength(1)
    expect(subprocess.spawns[0]?.signal).toBe(controller.signal)
  })

  it('fails nonzero exits, invalid frames, unframed stdout, and output overflow', async () => {
    const nonzero = await setup()
    nonzero.subprocess.run = () => Promise.resolve({ outcome: { exitCode: 9, signal: null }, stderr: 'boom\n' })
    await expect(nonzero.ctx.browser.runPlan(plan)).rejects.toMatchObject({ code: 'BROWSER_PROVIDER_FAILED' })

    const invalid = await setup()
    invalid.subprocess.run = () => Promise.resolve({
      outcome: { exitCode: 0, signal: null },
      stdout: `${EgoLite.EGO_LITE_FRAME_PREFIX}{not-json}\n`,
    })
    await expect(invalid.ctx.browser.runPlan(plan)).rejects.toMatchObject({ code: 'BROWSER_PROTOCOL' })

    const mixed = await setup()
    mixed.subprocess.run = () => Promise.resolve({
      ...successFrame(planResult),
      stdout: `business output\n${successFrame(planResult).stdout}`,
    })
    await expect(mixed.ctx.browser.runPlan(plan)).rejects.toMatchObject({ code: 'BROWSER_PROTOCOL' })

    const overflow = await setup({ executable: '/Applications/ego-browser', stdoutMaxBytes: 8 })
    overflow.subprocess.run = () => Promise.resolve({ ...successFrame(planResult), stdoutLossy: true })
    await expect(overflow.ctx.browser.runPlan(plan)).rejects.toMatchObject({ code: 'BROWSER_OUTPUT_LIMIT' })

    const stderrOverflow = await setup({ executable: '/Applications/ego-browser', stderrMaxBytes: 8 })
    stderrOverflow.subprocess.run = () => Promise.resolve({ ...successFrame(planResult), stderrLossy: true })
    await expect(stderrOverflow.ctx.browser.runPlan(plan)).rejects.toMatchObject({ code: 'BROWSER_OUTPUT_LIMIT' })
  })

  it('enforces browser-js-v1 JSON output bounds inside the single heredoc', async () => {
    const oversized: BrowserRunProgramV1 = {
      ...program,
      source: 'return { value: "too large" }',
      output: { kind: 'json', maxBytes: 2 },
    }
    const { ctx, subprocess } = await setup()
    subprocess.run = spec => executeFixtureSource((spec.stdio.stdin as { data: string }).data)

    await expect(ctx.browser.runProgram(oversized)).rejects.toMatchObject({ code: 'BROWSER_OUTPUT_LIMIT' })
    expect(subprocess.spawns).toHaveLength(1)
  })

  it('rejects non-JSON program output and page-evaluation values', async () => {
    const { ctx, subprocess } = await setup()
    subprocess.run = spec => executeFixtureSource((spec.stdio.stdin as { data: string }).data)

    await expect(ctx.browser.runProgram({
      ...program,
      source: 'return Number.NaN',
      output: { kind: 'json', maxBytes: 100 },
    })).rejects.toMatchObject({ code: 'BROWSER_PROTOCOL' })

    await expect(ctx.browser.runProgram({
      ...program,
      source: `
        await browser.run({kind:"open",id:"open",page:"main",url:"https://example.com",reuse:"exact-url",waitUntil:"load"});
        await browser.evaluate("main", "() => undefined");
        return "must not succeed";
      `,
      requiredCapabilities: ['page-evaluate'],
    })).rejects.toMatchObject({ code: 'BROWSER_PROTOCOL' })
    expect(subprocess.spawns).toHaveLength(2)
  })

  it('runs the remaining portable interactions, waits, and explicit control transitions', async () => {
    const operations: BrowserRunPlanV1['operations'] = [
      plan.operations[0]!,
      { kind: 'select-page', id: op('select-page'), page: pageKey('selected'), match: { kind: 'url-prefix', prefix: 'https://example.' } },
      { kind: 'reload', id: op('reload'), page: pageKey('selected'), waitUntil: 'dom-content-loaded' },
      { kind: 'page-info', id: op('page-info'), page: pageKey('selected') },
      { kind: 'click', id: op('click'), page: pageKey('selected'), locator: { kind: 'text', text: 'Go', exact: true } },
      { kind: 'fill', id: op('fill'), page: pageKey('selected'), locator: { kind: 'label', label: 'Name' }, value: 'Ada' },
      { kind: 'clear', id: op('clear'), page: pageKey('selected'), locator: { kind: 'placeholder', placeholder: 'Name' } },
      { kind: 'press', id: op('press'), page: pageKey('selected'), locator: { kind: 'test-id', testId: 'search' }, key: 'Enter' },
      { kind: 'check', id: op('check'), page: pageKey('selected'), locator: { kind: 'css', selector: '#ok' }, checked: true },
      { kind: 'select', id: op('select'), page: pageKey('selected'), locator: { kind: 'css', selector: 'select' }, values: ['a'] },
      { kind: 'read', id: op('value'), page: pageKey('selected'), locator: { kind: 'css', selector: 'input' }, target: { kind: 'value' } },
      { kind: 'read', id: op('html'), page: pageKey('selected'), locator: { kind: 'css', selector: 'main' }, target: { kind: 'html' } },
      { kind: 'read', id: op('attribute'), page: pageKey('selected'), locator: { kind: 'css', selector: 'main' }, target: { kind: 'attribute', name: 'data-id' } },
      { kind: 'wait', id: op('wait-load'), condition: { kind: 'load', page: pageKey('selected'), state: 'load' } },
      { kind: 'wait', id: op('wait-url'), condition: { kind: 'url', page: pageKey('selected'), match: { kind: 'exact-url', url: 'https://example.com' } } },
      { kind: 'wait', id: op('wait-locator'), condition: { kind: 'locator', page: pageKey('selected'), locator: { kind: 'css', selector: 'main' }, state: 'visible' } },
      { kind: 'handoff', id: op('handoff'), note: 'manual review' },
      { kind: 'wait', id: op('wait-user'), condition: { kind: 'control', control: 'user' } },
      { kind: 'takeover', id: op('takeover') },
      { kind: 'close-page', id: op('close'), page: pageKey('selected') },
      { kind: 'complete', id: op('complete'), keep: true },
    ]
    const { ctx, subprocess } = await setup()
    subprocess.run = spec => executeFixtureSource((spec.stdio.stdin as { data: string }).data)

    const result = await ctx.browser.runPlan({ ...plan, operations })

    expect(result.operations).toHaveLength(operations.length)
    expect(result.operations[16]).toMatchObject({ kind: 'control', control: 'user' })
    expect(result.operations[18]).toMatchObject({ kind: 'control', control: 'agent' })
    expect(result.workspace).toMatchObject({ lifecycle: 'completed', control: 'user' })
  })

  it('evaluates a page function and preserves text grapheme bounds in trusted-plugin mode', async () => {
    const evaluated: BrowserRunProgramV1 = {
      ...program,
      source: `
        await browser.run({kind:"open",id:"open",page:"main",url:"https://example.com",reuse:"exact-url",waitUntil:"load"});
        const value = await browser.evaluate("main", "(input) => input + '👨‍👩‍👧‍👦x'", "ok:");
        return value;
      `,
      output: { kind: 'text', maxCharacters: 4 },
      requiredCapabilities: ['page-evaluate'],
    }
    const { ctx, subprocess } = await setup()
    subprocess.run = spec => executeFixtureSource((spec.stdio.stdin as { data: string }).data)

    await expect(ctx.browser.runProgram(evaluated)).resolves.toMatchObject({
      output: { kind: 'text', value: 'ok:👨‍👩‍👧‍👦', truncated: true },
    })
  })
})

describe('Ego Lite discovery and explicit partial mappings', () => {
  it('prefers the configured absolute executable and rejects a configured relative path', async () => {
    const configured = await setup({ executable: '/opt/ego-browser' })
    expect(configured.subprocess.resolutions).toEqual(['/opt/ego-browser'])

    const ctx = new Context()
    await ctx.plugin(BrowserRuntime)
    await ctx.plugin(FakeSubprocess)
    await expect(ctx.plugin(EgoLite, { executable: 'ego-browser' })).rejects.toThrow('must be an absolute path')
  })

  it('probes ~/.local/bin before the installed app helper and never guesses through PATH', async () => {
    const ctx = new Context()
    await ctx.plugin(BrowserRuntime)
    await ctx.plugin(FakeSubprocess)
    const subprocess = ctx.subprocess as FakeSubprocess
    subprocess.resolve = () => Promise.reject(new Error('missing'))
    await ctx.plugin(EgoLite, {})

    expect(subprocess.resolutions.at(-1)).toBe(EgoLite.DEFAULT_EGO_LITE_APP_EXECUTABLE)
    expect(subprocess.resolutions).not.toContain('ego-browser')
    if (process.env.HOME !== undefined) {
      expect(subprocess.resolutions[0]).toBe(join(process.env.HOME, '.local', 'bin', 'ego-browser'))
    }
    await expect(ctx.browser.runPlan(plan)).rejects.toMatchObject({ code: 'BROWSER_UNAVAILABLE' })
    expect(subprocess.spawns).toHaveLength(0)
  })

  it('selects the installed app helper when the user-local executable is absent', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeSubprocess)
    const subprocess = ctx.subprocess as FakeSubprocess
    subprocess.resolve = command => command === EgoLite.DEFAULT_EGO_LITE_APP_EXECUTABLE
      ? Promise.resolve(command)
      : Promise.reject(new Error('missing'))

    await expect(EgoLite.resolveEgoLiteExecutable(subprocess, undefined, '/Users/fixture')).resolves.toEqual({
      path: EgoLite.DEFAULT_EGO_LITE_APP_EXECUTABLE,
      source: 'application',
    })
    expect(subprocess.resolutions).toEqual([
      '/Users/fixture/.local/bin/ego-browser',
      EgoLite.DEFAULT_EGO_LITE_APP_EXECUTABLE,
    ])
  })

  it('fails unsupported current workspace, no-reuse open, and pages before spawning', async () => {
    const open = plan.operations[0]
    if (open?.kind !== 'open') throw new Error('fixture must begin with an open operation')
    const cases: BrowserRunPlanV1[] = [
      { ...plan, workspace: { kind: 'current' } },
      { ...plan, operations: [{ ...open, reuse: 'never' }] },
      { ...plan, operations: [{ kind: 'pages', id: op('pages') }] },
    ]
    for (const unsupported of cases) {
      const { ctx, subprocess } = await setup()
      await expect(ctx.browser.runPlan(unsupported)).rejects.toMatchObject({ code: 'BROWSER_UNSUPPORTED_OPERATION' })
      expect(subprocess.spawns).toHaveLength(0)
    }
  })

  it('maps spawn creation and outcome rejection without retrying', async () => {
    const spawnFailure = await setup()
    spawnFailure.subprocess.spawnError = new Error('spawn failed')
    await expect(spawnFailure.ctx.browser.runPlan(plan)).rejects.toMatchObject({ code: 'BROWSER_PROVIDER_FAILED' })
    expect(spawnFailure.subprocess.spawns).toHaveLength(1)

    const doneFailure = await setup()
    doneFailure.subprocess.doneError = new Error('done failed')
    await expect(doneFailure.ctx.browser.runPlan(plan)).rejects.toMatchObject({ code: 'BROWSER_PROVIDER_FAILED' })
    expect(doneFailure.subprocess.spawns).toHaveLength(1)
  })

  it('decodes branded portable results without native identifiers', async () => {
    const { ctx } = await setup()
    const result = await ctx.browser.runPlan(plan)

    expect(result.workspace.id).toBe(BrowserWorkspaceId('ego-lite:7'))
    expect(result.operations[0]).toMatchObject({ id: op('open-main'), page: { page: pageKey('main') } })
  })

  it('rejects current workspace for browser-js-v1 before spawning', async () => {
    const { ctx, subprocess } = await setup()
    await expect(ctx.browser.runProgram({ ...program, workspace: { kind: 'current' } }))
      .rejects.toMatchObject({ code: 'BROWSER_UNSUPPORTED_OPERATION' })
    expect(subprocess.spawns).toHaveLength(0)
  })

  it('validates cwd, resource limits, and unavailable direct Provider calls', async () => {
    for (const config of [
      { executable: '/ego', cwd: 'relative' },
      { executable: '/ego', graceMs: 0 },
      { executable: '/ego', stdoutMaxBytes: 1.5 },
      { executable: '/ego', stderrMaxBytes: 0 },
      { executable: '/ego', operationTimeoutMs: Number.POSITIVE_INFINITY },
      { executable: '/ego', graceMs: 2 ** 31 },
    ] satisfies EgoLite.Config[]) {
      const ctx = new Context()
      await ctx.plugin(BrowserRuntime)
      await ctx.plugin(FakeSubprocess)
      await expect(ctx.plugin(EgoLite, config)).rejects.toThrow('browser-ego-lite:')
    }

    const ctx = new Context()
    await ctx.plugin(FakeSubprocess)
    const provider = new EgoLite.EgoLiteBrowserProvider(ctx, {
      cwd: process.cwd(),
      graceMs: 1,
      stdoutMaxBytes: 1,
      stderrMaxBytes: 1,
      operationTimeoutMs: 1,
    }, undefined)
    expect(provider.available()).toBe(false)
    await expect(provider.runPlan(plan)).rejects.toMatchObject({ code: 'BROWSER_UNAVAILABLE' })
  })
})

describe('Ego Lite subprocess validation', () => {
  const processConfig: EgoLite.EgoLiteProcessConfig = {
    executable: '/ego-browser',
    cwd: process.cwd(),
    graceMs: 1,
    stdoutMaxBytes: 1024,
    stderrMaxBytes: 1024,
  }

  async function processHarness() {
    const ctx = new Context()
    await ctx.plugin(FakeSubprocess)
    return { ctx, subprocess: ctx.subprocess as FakeSubprocess }
  }

  it('classifies pre-launch and launch-race aborts', async () => {
    const pre = await processHarness()
    await expect(EgoLite.runEgoLiteProcess(pre.ctx, processConfig, 'code', AbortSignal.abort('stop')))
      .rejects.toMatchObject({ code: 'BROWSER_ABORTED' })
    expect(pre.subprocess.spawns).toHaveLength(0)

    const race = await processHarness()
    const controller = new AbortController()
    race.subprocess.beforeSpawn = () => { controller.abort('race') }
    race.subprocess.spawnError = new Error('spawn raced')
    await expect(EgoLite.runEgoLiteProcess(race.ctx, processConfig, 'code', controller.signal))
      .rejects.toMatchObject({ code: 'BROWSER_ABORTED' })
  })

  it('classifies abort during rejected completion and missing collectors', async () => {
    const aborted = await processHarness()
    const controller = new AbortController()
    aborted.subprocess.beforeSpawn = () => { controller.abort('race') }
    aborted.subprocess.doneError = new Error('done raced')
    await expect(EgoLite.runEgoLiteProcess(aborted.ctx, processConfig, 'code', controller.signal))
      .rejects.toMatchObject({ code: 'BROWSER_ABORTED' })

    const missing = await processHarness()
    missing.subprocess.dropReaders = true
    await expect(EgoLite.runEgoLiteProcess(missing.ctx, processConfig, 'code'))
      .rejects.toMatchObject({ code: 'BROWSER_PROTOCOL' })
  })

  it('rejects signalled, empty-success, multiple, and malformed error frames', async () => {
    const cases: readonly [ScriptedRun, string][] = [
      [{ outcome: { exitCode: null, signal: 'SIGKILL' } }, 'BROWSER_PROVIDER_FAILED'],
      [{ outcome: { exitCode: 0, signal: null } }, 'BROWSER_PROTOCOL'],
      [{
        outcome: { exitCode: 0, signal: null },
        stdout: `${successFrame(planResult).stdout}${successFrame(planResult).stdout}`,
      }, 'BROWSER_PROTOCOL'],
      [{
        outcome: { exitCode: 1, signal: null },
        stderr: `${EgoLite.EGO_LITE_FRAME_PREFIX}${JSON.stringify({ ok: false, error: {} })}\n`,
      }, 'BROWSER_PROTOCOL'],
      [{
        outcome: { exitCode: 1, signal: null },
        stderr: `${EgoLite.EGO_LITE_FRAME_PREFIX}${JSON.stringify({ ok: 'maybe' })}\n`,
      }, 'BROWSER_PROTOCOL'],
      [{ outcome: { exitCode: 0, signal: null }, stderrLossy: true }, 'BROWSER_OUTPUT_LIMIT'],
    ]
    for (const [run, code] of cases) {
      const { ctx, subprocess } = await processHarness()
      subprocess.run = () => Promise.resolve(run)
      await expect(EgoLite.runEgoLiteProcess(ctx, processConfig, 'code')).rejects.toMatchObject({ code })
    }
  })

  it('maps every published Ego failure family and emitted portable error family', async () => {
    const mappings = [
      ['EGO_TASK_SPACE_NOT_FOUND', 'BROWSER_WORKSPACE_INACTIVE'],
      ['EGO_TASK_SPACE_NOT_SELECTED', 'BROWSER_WORKSPACE_INACTIVE'],
      ['EGO_TASK_SPACE_UNAVAILABLE', 'BROWSER_WORKSPACE_INACTIVE'],
      ['EGO_BROWSER_UNAVAILABLE', 'BROWSER_UNAVAILABLE'],
      ['EGO_CDP_CHANNEL_UNAVAILABLE', 'BROWSER_UNAVAILABLE'],
      ['EGO_TASK_HOST_DISCONNECTED', 'BROWSER_UNAVAILABLE'],
      ['EGO_WEB_CONTENTS_UNAVAILABLE', 'BROWSER_UNAVAILABLE'],
      ['EGO_INVALID_ARGUMENT', 'BROWSER_PROTOCOL'],
      ['EGO_INVALID_RESULT_PAYLOAD', 'BROWSER_PROTOCOL'],
      ['EGO_RESULT_CONVERSION_FAILED', 'BROWSER_PROTOCOL'],
      ['EGO_CDP_SEND_FAILED', 'BROWSER_PROVIDER_FAILED'],
      ['EGO_OPERATION_FAILED', 'BROWSER_PROVIDER_FAILED'],
      ['EGO_SNAPSHOT_FAILED', 'BROWSER_PROVIDER_FAILED'],
    ] as const
    for (const [native, portable] of mappings) {
      const { ctx, subprocess } = await processHarness()
      subprocess.run = () => Promise.resolve(errorFrame({ message: native, error_code: native }))
      await expect(EgoLite.runEgoLiteProcess(ctx, processConfig, 'code')).rejects.toMatchObject({ code: portable })
    }

    for (const code of [
      'BROWSER_UNAVAILABLE',
      'BROWSER_UNSUPPORTED_OPERATION',
      'BROWSER_USER_CONTROL',
      'BROWSER_WORKSPACE_INACTIVE',
      'BROWSER_PAGE_STALE',
      'BROWSER_TIMEOUT',
      'BROWSER_PROTOCOL',
      'BROWSER_OUTPUT_LIMIT',
      'UNKNOWN_CODE',
    ]) {
      const { ctx, subprocess } = await processHarness()
      subprocess.run = () => Promise.resolve(errorFrame({ message: code, dsh_code: code, operationId: 'operation' }))
      const expected = code === 'UNKNOWN_CODE' ? 'BROWSER_PROTOCOL' : code
      await expect(EgoLite.runEgoLiteProcess(ctx, processConfig, 'code')).rejects.toMatchObject({
        code: expected,
        operationId: op('operation'),
      })
    }
  })

  it('rejects invalid decoded plan and program data at the process boundary', () => {
    expect(() => EgoLite.decodePlanResult(null, plan)).toThrow(BrowserError)
    expect(() => EgoLite.decodePlanResult({ version: 2, operations: [] }, plan)).toThrow(BrowserError)
    expect(() => EgoLite.decodePlanResult({ version: 1, operations: [] }, plan)).toThrow(BrowserError)
    expect(() => EgoLite.decodePlanResult({
      ...planResult,
      operations: [{ ...planResult.operations[0], id: 'wrong' }],
    }, plan)).toThrow(BrowserError)

    const none = { ...program, output: { kind: 'none' as const } }
    expect(EgoLite.decodeProgramResult({
      version: 1,
      workspace: planResult.workspace,
      output: { kind: 'none' },
    }, none)).toMatchObject({ output: { kind: 'none' } })
    const json = { ...program, output: { kind: 'json' as const, maxBytes: 100 } }
    expect(EgoLite.decodeProgramResult({
      version: 1,
      workspace: planResult.workspace,
      output: { kind: 'json', value: { nested: [null, true, 1, 'text'] } },
    }, json)).toMatchObject({ output: { kind: 'json' } })
    expect(() => EgoLite.decodeProgramResult({
      version: 1,
      workspace: planResult.workspace,
      output: { kind: 'json', value: undefined },
    }, json)).toThrow(BrowserError)
    expect(() => EgoLite.decodeProgramResult({ version: 2, output: {}, workspace: {} }, program)).toThrow(BrowserError)
  })
})
