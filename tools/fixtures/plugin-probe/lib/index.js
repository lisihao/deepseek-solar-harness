import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const RESIDENT_SERVICE = 'solarNativeResident'
const NATIVE_CONTROL_SERVICE = 'solarNativeControl'
const WORKFLOW_SERVICE = 'solarWorkflowStudio'
const WORKFLOW_CONTROL_SERVICE = 'solarWorkflowControl'
const COLLABORATION_RUNTIME = 'native-collaboration'
const WORKFLOW_RPC_METHODS = ['overview', 'refreshSource', 'save', 'validate', 'run', 'inspect', 'resume', 'setMode']

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
    ? ['solar_delegate', 'solar_resident', 'solar_coordinate', 'solar_wait']
    : ['solar_resident']
  const checks = {
    tools: [],
    baseProfileServices: [],
    service: false,
    listed: false,
    waitTool: false,
    workflowService: false,
    workflowOwnerRpc: [],
    workflowOverview: false,
    queued: false,
    paused: false,
    cancelled: false,
    collaborationDisposed: false,
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
    if (expectCollaboration) {
      assert(names.has('solar_wait'), 'solar_wait is absent from the tool schema catalog')
      assert(typeof tools.get === 'function' && tools.get('solar_wait') !== undefined, 'solar_wait is not registered as a callable tool')
      checks.waitTool = true
      // The collaboration bundle now depends on these public base-profile
      // services. Record their actual scratch-profile availability before
      // touching any execution path.
      for (const serviceName of ['agents', 'systemPrompt']) {
        assert(ctx.get(serviceName) !== undefined, `base profile service ${serviceName} is unavailable`)
        checks.baseProfileServices.push(serviceName)
      }
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
      const control = ctx.get(NATIVE_CONTROL_SERVICE)
      assert(control !== undefined && typeof control.status === 'function', 'native collaboration UI control is unavailable')
      const status = await control.status()
      assert(status.resident.available === true, 'UI status cannot reach Resident')
      assert(status.tools.every(tool => tool.available), 'UI status is missing a native tool')
      checks.uiStatus = true

      const studio = ctx.get(WORKFLOW_SERVICE)
      assert(studio !== undefined && typeof studio.register === 'function' && typeof studio.capture === 'function', 'workflow Studio service is unavailable')
      checks.workflowService = true
      const workflowControl = ctx.get(WORKFLOW_CONTROL_SERVICE)
      assert(workflowControl !== undefined, 'workflow Studio owner control is unavailable')
      const binding = workflowControl.typertRemote
      assert(binding?.serviceKey === WORKFLOW_CONTROL_SERVICE && binding.namespace === WORKFLOW_CONTROL_SERVICE, 'workflow Studio owner control is not bound to its Typert namespace')
      for (const method of WORKFLOW_RPC_METHODS) {
        assert(typeof workflowControl[method] === 'function', `workflow Studio owner RPC ${method} is unavailable`)
        checks.workflowOwnerRpc.push(method)
      }
      // Direct invocation carries no Remote peer and is therefore the local
      // owner path. overview reads only durable state; it does not submit work.
      const overview = await workflowControl.overview({ sessionId: `plugin-probe-session-${process.pid}` })
      assert(overview?.sessionId === `plugin-probe-session-${process.pid}`, 'workflow Studio overview did not preserve the requested session')
      assert(Array.isArray(overview.providers) && Array.isArray(overview.sources) && Array.isArray(overview.drafts) && Array.isArray(overview.runs), 'workflow Studio overview is incomplete')
      checks.workflowOverview = true
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

    if (expectCollaboration) {
      // Dispose only the collaboration bundle after all existing Resident
      // queue/pause/cancel evidence has been collected. Resident itself stays
      // available for the driver cleanup.
      const runtimes = [...ctx.registry.values()].filter(runtime => runtime.name === COLLABORATION_RUNTIME)
      assert(runtimes.length === 1 && runtimes[0].fibers.length === 1, 'native collaboration plugin owner fiber is not unique')
      const [ownerFiber] = [...runtimes[0].fibers]
      await ownerFiber.dispose()
      assert(ctx.get(WORKFLOW_SERVICE) === undefined, 'workflow Studio service remained registered after collaboration dispose')
      assert(ctx.get(WORKFLOW_CONTROL_SERVICE) === undefined, 'workflow Studio owner control remained registered after collaboration dispose')
      assert(ctx.get(NATIVE_CONTROL_SERVICE) === undefined, 'native collaboration control remained registered after collaboration dispose')
      for (const tool of ['solar_delegate', 'solar_coordinate', 'solar_wait']) {
        assert(tools.get(tool) === undefined, `${tool} remained registered after collaboration dispose`)
      }
      checks.collaborationDisposed = true
    }
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
