import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const RESIDENT_SERVICE = 'solarNativeResident'

function expectedCollaboration() {
  const value = process.env.SOLAR_PROBE_EXPECT_COLLABORATION
  if (value !== '0' && value !== '1') throw new Error('plugin probe requires SOLAR_PROBE_EXPECT_COLLABORATION=0 or 1')
  return value === '1'
}

function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`plugin probe requires ${name}`)
  return value
}

function serialiseError(error) {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack }
  return { name: 'UnknownError', message: String(error) }
}

async function writeMarker(markerPath, marker) {
  await mkdir(dirname(markerPath), { recursive: true })
  await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function graphForProbe() {
  return {
    formatVersion: 1,
    id: `plugin-probe-${process.pid}-${Date.now()}`,
    label: 'V4 native plugin scratch-profile probe',
    cwd: process.cwd(),
    maxParallel: 1,
    // Keep the node queued while the probe exercises list/pause/cancel. The
    // test never starts a native product or asks for a model.
    notBefore: Date.now() + 60_000,
    nodes: [{ id: 'probe-node', executor: 'codex', prompt: 'probe must never run' }],
  }
}

async function runProbe(ctx) {
  const markerPath = requiredEnv('SOLAR_PLUGIN_PROBE_MARKER')
  const expectCollaboration = expectedCollaboration()
  const expectedTools = expectCollaboration
    ? ['solar_delegate', 'solar_resident', 'solar_coordinate']
    : ['solar_resident']
  const checks = {
    tools: [],
    service: false,
    listed: false,
    queued: false,
    paused: false,
    cancelled: false,
  }
  let resident
  let graphId
  let error
  try {
    const tools = ctx.get('tools')
    assert(tools !== undefined, 'tools service is unavailable')
    const schemas = tools.schemas()
    const names = new Set(schemas.map((schema) => schema.name))
    for (const tool of expectedTools) {
      assert(names.has(tool), `expected tool ${tool} is not registered`)
      checks.tools.push(tool)
    }

    resident = ctx.get(RESIDENT_SERVICE)
    assert(resident !== undefined, `${RESIDENT_SERVICE} service is unavailable`)
    assert(resident.protocolVersion === 1, `Resident protocolVersion must be 1, got ${String(resident.protocolVersion)}`)
    assert(typeof resident.list === 'function', 'Resident list() is unavailable')
    assert(typeof resident.submit === 'function', 'Resident submit() is unavailable')
    assert(typeof resident.control === 'function', 'Resident control() is unavailable')
    checks.service = true

    const initial = await resident.list()
    assert(Array.isArray(initial), 'Resident list() did not return an array')
    checks.listed = true

    if (expectCollaboration) {
      const control = ctx.get('solarNativeControl')
      assert(control !== undefined && typeof control.status === 'function', 'native collaboration UI control is unavailable')
      const status = await control.status()
      assert(status.resident.available === true, 'UI status cannot reach Resident')
      assert(status.tools.every(tool => tool.available), 'UI status is missing a native tool')
      checks.uiStatus = true
    }

    const submitted = await resident.submit({ commandId: `plugin-probe-submit-${process.pid}`, graph: graphForProbe() })
    graphId = submitted.graph.id
    assert(submitted.status === 'queued', `expected queued graph, got ${String(submitted.status)}`)
    checks.queued = true

    const paused = await resident.control({
      commandId: `plugin-probe-pause-${process.pid}`,
      graphId,
      action: 'pause',
      expectedRevision: submitted.revision,
    })
    assert(paused.status === 'paused', `expected paused graph, got ${String(paused.status)}`)
    checks.paused = true

    const cancelled = await resident.control({
      commandId: `plugin-probe-cancel-${process.pid}`,
      graphId,
      action: 'cancel',
      expectedRevision: paused.revision,
    })
    assert(cancelled.status === 'cancelled', `expected cancelled graph, got ${String(cancelled.status)}`)
    checks.cancelled = true
  } catch (caught) {
    error = serialiseError(caught)
  }

  const marker = {
    formatVersion: 1,
    pid: process.pid,
    ok: error === undefined,
    checks,
    expectedCollaboration: expectCollaboration,
    ...(graphId === undefined ? {} : { graphId }),
    ...(error === undefined ? {} : { error }),
  }
  await writeMarker(markerPath, marker)
  const exit = ctx.get('appExit')
  if (typeof exit !== 'function') throw new Error('appExit service is unavailable after probe marker write')
  exit(error === undefined ? 0 : 1)
}

export const name = 'solar-plugin-probe'
export const inject = ['appReady']

export function apply(ctx) {
  const ready = ctx.get('appReady')
  if (ready === undefined || typeof ready.onReady !== 'function') {
    throw new Error('appReady service is unavailable')
  }
  let started = false
  const cancel = ready.onReady(() => {
    if (started) return
    started = true
    void runProbe(ctx).catch(async (error) => {
      try {
        const markerPath = requiredEnv('SOLAR_PLUGIN_PROBE_MARKER')
        await writeMarker(markerPath, {
          formatVersion: 1,
          pid: process.pid,
          ok: false,
          checks: {},
          error: serialiseError(error),
        })
      } finally {
        const exit = ctx.get('appExit')
        if (typeof exit === 'function') exit(1)
      }
    })
  })
  return () => cancel()
}
