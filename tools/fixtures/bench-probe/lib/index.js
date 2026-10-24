import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`bench probe requires ${name}`)
  return value
}

async function writeMarker(path, marker) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
}

async function runProbe(ctx) {
  const markerPath = requiredEnv('SOLAR_PLUGIN_PROBE_MARKER')
  const expectedRoot = join(requiredEnv('DSH_HOME'), 'solar', 'bench', 'ledgers')
  const checks = { suite: false, ledgerRoot: false, list: false, detail: false, verdict: false, choices: false }
  let error
  try {
    const registry = ctx.get('solarBenchmarks')
    const suite = registry?.suite('dsh-native')
    const tasks = suite === undefined ? [] : await suite.load()
    assert(tasks.length === 14, `dsh-native suite has ${tasks.length} tasks`)
    assert(['command-exit', 'file-contains', 'session-event'].every(kind => registry.grader(kind) !== undefined), 'built-in graders missing')
    checks.suite = true
    const runtime = ctx.get('solarBenchRuntime')
    assert(runtime?.ledgerRoot === expectedRoot, `ledger root is ${runtime?.ledgerRoot}`)
    checks.ledgerRoot = true
    const ledgers = ctx.get('solarBenchLedgers')
    const list = await ledgers.list()
    assert(list.experiments.length === 1 && list.experiments[0].id === 'probe-ablation' && list.experiments[0].runs === 8, `list: ${JSON.stringify(list)}`)
    assert(list.unreadable.length === 0, `unreadable: ${JSON.stringify(list.unreadable)}`)
    checks.list = true
    const detail = await ledgers.detail({ id: 'probe-ablation' })
    assert(detail.records.length === 8 && detail.analysis.variants.length === 2, 'detail is incomplete')
    checks.detail = true
    assert(detail.analysis.comparisons[0]?.verdict === 'insufficient', `verdict ${detail.analysis.comparisons[0]?.verdict}`)
    checks.verdict = true
    const choices = await ctx.get('solarBenchRuns').choices()
    assert(choices.suites.some(suite => suite.id === 'dsh-native' && suite.tasks.length === 14), 'choices lack the dsh-native suite')
    assert(JSON.stringify(choices.plugins.map(plugin => plugin.name)) === JSON.stringify(['@lisihao/dsh-solar-bench-probe']), `choices list ${JSON.stringify(choices.plugins)}`)
    assert(choices.credential === false, 'a scrubbed home must report no credential')
    checks.choices = true
  } catch (caught) {
    error = { name: caught?.name, message: caught?.message ?? String(caught), stack: caught?.stack }
  }
  await writeMarker(markerPath, { formatVersion: 1, pid: process.pid, ok: error === undefined, checks, ...(error === undefined ? {} : { error }) })
  ctx.get('appExit')(error === undefined ? 0 : 1)
}

export const name = 'bench-plugin-probe'
export const inject = ['appReady', 'solarBenchmarks', 'solarBenchRuntime', 'solarBenchLedgers', 'solarBenchRuns']

export function apply(ctx) {
  const ready = ctx.get('appReady')
  if (ready === undefined || typeof ready.onReady !== 'function') throw new Error('appReady service is unavailable')
  let started = false
  const cancel = ready.onReady(() => {
    if (started) return
    started = true
    void runProbe(ctx).catch(() => ctx.get('appExit')?.(1))
  })
  return () => cancel()
}
