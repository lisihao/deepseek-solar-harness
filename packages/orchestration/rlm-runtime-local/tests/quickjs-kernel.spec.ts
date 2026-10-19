import { describe, expect, it, vi } from 'vitest'
import type { KernelHooks } from '../src/kernel.ts'
import { PersistentQuickJSKernel, type QuickJSKernelLimits } from '../src/quickjs-kernel.ts'

const limits: QuickJSKernelLimits = {
  memoryLimitBytes: 32 * 1024 * 1024, maxStackBytes: 256 * 1024,
  maxInterruptChecks: 10_000, maxBridgeBytes: 1024 * 1024, maxLogBytes: 4096,
  maxCellSourceBytes: 64 * 1024, maxHostCalls: 16, maxPendingHostCalls: 4, jobBatchSize: 8,
}
const snapshots = { maxBytes: 512 * 1024, maxVariableBytes: 256 * 1024 }
function hooks(overrides: Partial<KernelHooks> = {}): KernelHooks {
  const denied = (): Promise<never> => Promise.reject(new Error('unused host method'))
  return {
    spawn: denied, listChildren: denied, childSummaries: denied, readChildResult: denied, deleteChild: denied,
    sendMessage: denied, broadcastMessage: denied, listAgents: denied, readMessages: denied,
    harness: denied, skill: denied, setGoal: denied, getGoal: denied, completeGoal: denied,
    createHeartbeat: denied, listHeartbeats: denied, updateHeartbeat: denied, deleteHeartbeat: denied,
    compactStatus: denied, compactRun: denied, ...overrides,
  }
}

function kernel(overrides: Partial<KernelHooks> = {}, resource = limits) {
  return new PersistentQuickJSKernel({ material: 'alpha beta gamma' }, hooks(overrides), [], resource, snapshots)
}

describe('persistent QuickJS kernel', () => {
  it.each([
    'let a = new Array(3); a[0] = "x"; a',
    'let a = [1]; a.note = "must retain"; a',
  ])('marks non-JSON arrays unavailable in results and after reopen: %s', async (code) => {
    const vm = kernel()
    let saved
    try {
      saved = await vm.execute(code, 4000)
      expect(saved.value).toBeUndefined()
      expect(saved.display).toBe('[non-JSON value; complete JSON result unavailable]')
      expect(saved.degradedVariables).toEqual(['a'])
      expect(saved.variables[0]).toMatchObject({ name: 'a', error: expect.any(String) })
      expect((await vm.execute('a.length', 2000)).value).toBe(code.includes('new Array') ? 3 : 1)
    } finally { await vm.dispose() }
    const restored = new PersistentQuickJSKernel(saved.context ?? {}, hooks(), saved.variables, limits, snapshots)
    try { await expect(restored.execute('a', 4000)).rejects.toThrow("'a' is not defined") }
    finally { await restored.dispose() }
  })

  it('returns and restores dense nested JSON arrays without losing values', async () => {
    const expected = [[], [1, null, { text: '完整🌞', nested: [false, 2] }]]
    const vm = kernel()
    let saved
    try {
      saved = await vm.execute('let a = ' + JSON.stringify(expected) + '; a', 4000)
      expect(saved.value).toEqual(expected)
      expect(saved.degradedVariables).toEqual([])
    } finally { await vm.dispose() }
    const restored = new PersistentQuickJSKernel(saved.context ?? {}, hooks(), saved.variables, limits, snapshots)
    try { expect((await restored.execute('a', 4000)).value).toEqual(expected) }
    finally { await restored.dispose() }
  })

  it('keeps lexical bindings and helper closures across cells, with native const and nested scope behavior', async () => {
    const vm = kernel()
    try {
      await vm.execute('let total = 2; const fixed = 3; let { a, b } = { a: 4, b: 5 }; function sum(){ return total + a + b }; function fact(n){ return n<2 ? 1 : n*fact(n-1) };', 4000)
      expect((await vm.execute('total = 10; { let total = 99; } sum() + fixed', 2000)).value).toBe(22)
      expect((await vm.execute('total += 1; sum()', 2000)).value).toBe(20)
      expect((await vm.execute('fact(6)', 2000)).value).toBe(720)
      await expect(vm.execute('fixed = 9', 2000)).rejects.toThrow()
    } finally { await vm.dispose() }
  })

  it('runs a persisted async helper through the current cell host context', async () => {
    const calls: string[] = []
    const vm = kernel({ listChildren: async () => { calls.push('current'); return [{ name: 'child' }] } })
    try {
      await vm.execute('async function helper(){ return await rlm.listChildren() };', 4000)
      expect((await vm.execute('await helper()', 2000)).value).toEqual([{ name: 'child' }])
      expect(calls).toEqual(['current'])
    } finally { await vm.dispose() }
  })

  it('drains unawaited host continuations before committing the cell', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const seen: string[] = []
    const vm = kernel({ listChildren: async () => { seen.push('first'); await gate; return [] }, childSummaries: async () => { seen.push('second'); return [] } })
    try {
      let done = false
      const pending = vm.execute('rlm.listChildren().then(() => rlm.childSummaries()); 1', 4000).then((value) => { done = true; return value })
      await vi.waitFor(() => { expect(seen).toEqual(['first']) })
      expect(done).toBe(false)
      await expect(vm.execute('2', 100)).rejects.toMatchObject({ code: 'RLM_BUSY' })
      release()
      expect((await pending).value).toBe(1)
      expect(seen).toEqual(['first', 'second'])
      expect((await vm.execute('3', 2000)).value).toBe(3)
    } finally { release?.(); await vm.dispose() }
  })

  it('closes pending bridges on deadline and does not dispatch their late continuation', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const second = vi.fn(async () => [])
    const vm = kernel({ listChildren: async () => { await gate; return [] }, childSummaries: second })
    try {
      await vm.execute('1', 4000)
      await expect(vm.execute('rlm.listChildren().then(() => rlm.childSummaries()); 1', 60)).rejects.toMatchObject({ code: 'RLM_CELL_TIMEOUT' })
      release()
      await expect(vm.execute('2', 100)).rejects.toMatchObject({ code: 'RLM_UNAVAILABLE' })
      await vm.dispose()
      expect(second).not.toHaveBeenCalled()
    } finally { release?.(); await vm.dispose() }
  })

  it('restores pure JSON data without rerunning function or class initializers', async () => {
    const vm = kernel()
    let saved
    try {
      saved = await vm.execute('let n=3; let obj={a:4}; function helper(){ return n }; class C { static { n++ } }; let accessor={ get x(){ n++; return 5 } }; n', 4000)
      expect(saved.value).toBe(4)
      expect(saved.degradedVariables).toEqual(['helper', 'C', 'accessor'])
      expect((await vm.execute('n', 2000)).value).toBe(4)
    } finally { await vm.dispose() }
    const restored = new PersistentQuickJSKernel(saved.context ?? {}, hooks(), saved.variables, limits, snapshots)
    try { expect((await restored.execute('n + obj.a', 4000)).value).toBe(8) }
    finally { await restored.dispose() }
  })

  it('has no ambient Node, network or cross-session namespace', async () => {
    const first = kernel()
    const second = kernel()
    try {
      await first.execute('let hidden=7;', 4000)
      expect((await first.execute('[typeof process,typeof require,typeof fetch,typeof parentPort,typeof harness, ({}).constructor.constructor("return typeof process")()]', 2000)).value)
        .toEqual(['undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined'])
      expect((await second.execute('typeof hidden', 4000)).value).toBe('undefined')
      await expect(second.execute('import("node:fs")', 2000)).rejects.toThrow('modules')
    } finally { await first.dispose(); await second.dispose() }
  })

  it('interrupts synchronous loops and Promise storms without invoking host fallback', async () => {
    for (const code of ['while(true){}', 'function again(){Promise.resolve().then(again)}; again(); 1']) {
      const vm = kernel()
      try {
        await vm.execute('1', 4000)
        await expect(vm.execute(code, 80)).rejects.toThrow()
      } finally { await vm.dispose() }
    }
  })


  it('rejects guest heap and stack exhaustion', async () => {
    for (const code of ['new Array(10000000).fill("large")', 'function recurse(){return 1+recurse()}; recurse()']) {
      const vm = kernel()
      try { await expect(vm.execute(code, 4000)).rejects.toThrow() }
      finally { await vm.dispose() }
    }
  })


  it('preserves omitted optional bridge arguments and explicit null', async () => {
    const options: unknown[] = []
    const vm = kernel({ readChildResult: async (_child, value) => { options.push(value); return { omitted: value === undefined } } })
    try {
      expect((await vm.execute('await rlm.readChildResult("child")', 4000)).value).toEqual({ omitted: true })
      expect((await vm.execute('await rlm.readChildResult("child", null)', 2000)).value).toEqual({ omitted: false })
      expect(options).toEqual([undefined, null])
    } finally { await vm.dispose() }
  })

  it('refuses source, host-call and log limits', async () => {
    const source = kernel({}, { ...limits, maxCellSourceBytes: 8 })
    try { await expect(source.execute('"more than eight"', 2000)).rejects.toMatchObject({ code: 'RLM_OUTPUT_LIMIT' }) }
    finally { await source.dispose() }
    const host = kernel({ listChildren: async () => [] }, { ...limits, maxHostCalls: 1, maxPendingHostCalls: 1 })
    try { await expect(host.execute('await rlm.listChildren(); await rlm.listChildren()', 4000)).rejects.toThrow() }
    finally { await host.dispose() }
    const log = kernel({}, { ...limits, maxLogBytes: 8 })
    try { await expect(log.execute('console.log("0123456789")', 4000)).rejects.toThrow() }
    finally { await log.dispose() }
  })
})
