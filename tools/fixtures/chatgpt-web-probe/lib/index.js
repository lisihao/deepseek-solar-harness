import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const SERVICE = 'solarChatGptWebControl'
const PREFERENCES_SERVICE = 'solarWebPreferences'
const PROVIDER = 'chatgpt-web'
const TOOL = 'solar_chatgpt_web'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`chatgpt-web probe requires ${name}`)
  return value
}

function serialiseError(error) {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack }
  return { name: 'UnknownError', message: String(error) }
}

async function writeMarker(path, marker) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
}

async function runtimeArtifacts(root) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true, recursive: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  return entries
    .map(entry => join(entry.parentPath ?? root, entry.name))
    .filter(path => path.endsWith('.pid') || path.endsWith('.sock') || path.endsWith('.socket'))
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function runProbe(ctx) {
  const markerPath = requiredEnv('SOLAR_PLUGIN_PROBE_MARKER')
  const webRoot = join(requiredEnv('DSH_HOME'), 'solar', 'chatgpt-web')
  const checks = {
    tool: false,
    provider: false,
    providerContract: false,
    mainModelProvider: false,
    mainModelCatalog: false,
    mainModelInsightCatalog: false,
    preferencesControl: false,
    preferencesDefaults: false,
    preferencesReadNoEffect: false,
    mainModelDisposed: false,
    status: false,
    emptyRuns: false,
    emptyActiveIds: false,
    noExecutorInvocation: false,
    noBrowserTask: false,
    registrationsDisposed: false,
    preferencesDisposed: false,
    noPersistentArtifacts: false,
  }
  const exit = ctx.get('appExit')
  assert(typeof exit === 'function', 'appExit service is unavailable')
  let initialArtifacts = []
  let finalArtifacts = []
  let error
  try {
    const tools = ctx.get('tools')
    assert(tools !== undefined, 'tools service is unavailable')
    const tool = typeof tools.get === 'function' ? tools.get(TOOL) : undefined
    assert(tool !== undefined, `${TOOL} is not registered`)
    const schemas = typeof tools.schemas === 'function' ? tools.schemas() : []
    assert(schemas.some(schema => schema?.name === TOOL), `${TOOL} is absent from the tool schema catalog`)
    checks.tool = true

    const subagents = ctx.get('subagents')
    assert(subagents !== undefined && typeof subagents.getProvider === 'function', 'subagents service is unavailable')
    const provider = subagents.getProvider(PROVIDER)
    assert(provider !== undefined, `${PROVIDER} subagent provider is not registered`)
    assert(provider.name === PROVIDER, `subagent provider name must be ${PROVIDER}`)
    checks.provider = true
    if (provider.capabilities !== undefined) {
      for (const name of ['agentOptions', 'agentPreset', 'outputSchema', 'depthLimit']) {
        assert(provider.capabilities[name] === false, `chatgpt-web provider capability ${name} must be false`)
      }
      assert(provider.inheritsParentContext === false, 'chatgpt-web provider must not inherit parent context')
      checks.providerContract = true
    }

    const llm = ctx.get('llm')
    assert(llm !== undefined, 'llm service is unavailable')
    const mainProviders = await llm.listProviders()
    assert(mainProviders.some(item => item.id === 'solar-chatgpt-web'), 'main Web provider missing')
    checks.mainModelProvider = true
    const mainModels = await llm.listModels('solar-chatgpt-web')
    assert(mainModels.some(item => item.id === 'chatgpt-web' && item.name === 'ChatGPT 网页算子'), 'main Web catalog entry missing')
    checks.mainModelCatalog = true
    assert(mainModels.some(item => item.id === 'insight-analysis' && item.name === '洞察分析'), 'main Insight catalog entry missing')
    checks.mainModelInsightCatalog = true

    const preferencesPath = join(webRoot, 'preferences.json')
    assert(!(await exists(preferencesPath)), 'ChatGPT Web preferences exist before a read-only probe')
    const preferences = ctx.get(PREFERENCES_SERVICE)
    assert(preferences !== undefined && typeof preferences.read === 'function', `${PREFERENCES_SERVICE}.read() is unavailable`)
    const defaults = await preferences.read()
    const repeatedDefaults = await preferences.read()
    assert(defaults?.formatVersion === 1 && defaults.revision === 0, 'PreferencesControl.read() did not return the version-one defaults')
    assert(defaults.web?.modelLabel === 'GPT-6' && defaults.web?.effortLabel === 'medium', 'PreferencesControl.read() did not return the configured Web defaults')
    assert(defaults.insight?.formatVersion === 1, 'PreferencesControl.read() did not return default Insight preferences')
    assert(JSON.stringify(defaults) === JSON.stringify(repeatedDefaults), 'PreferencesControl.read() returned unstable defaults')
    assert(!(await exists(preferencesPath)), 'PreferencesControl.read() created persistent preferences')
    checks.preferencesControl = true
    checks.preferencesDefaults = true
    checks.preferencesReadNoEffect = true

    const control = ctx.get(SERVICE)
    assert(control !== undefined && typeof control.status === 'function', `${SERVICE}.status() is unavailable`)
    const status = await control.status()
    assert(status !== null && typeof status === 'object', `${SERVICE}.status() did not return an object`)
    assert(Array.isArray(status.runs), `${SERVICE}.status().runs is not an array`)
    assert(Array.isArray(status.activeIds), `${SERVICE}.status().activeIds is not an array`)
    assert(Array.isArray(status.errors), `${SERVICE}.status().errors is not an array`)
    assert(status.runs.length === 0, `${SERVICE}.status() reported runs before any request: ${JSON.stringify(status.runs)}`)
    assert(status.activeIds.length === 0, `${SERVICE}.status() reported activeIds before any request: ${JSON.stringify(status.activeIds)}`)
    assert(status.errors.length === 0, `${SERVICE}.status() reported errors before any request: ${JSON.stringify(status.errors)}`)
    checks.status = true
    checks.emptyRuns = true
    checks.emptyActiveIds = true

    initialArtifacts = await runtimeArtifacts(webRoot)
    assert(initialArtifacts.length === 0, `ChatGPT Web runtime artifacts exist before the probe: ${JSON.stringify(initialArtifacts)}`)
    // No provider.start() or tool executor is called in this probe. The empty
    // durable state is the observable no-browser-task check.
    checks.noExecutorInvocation = true
    checks.noBrowserTask = true

    // A traced service's ctx follows its caller; it is not its owner's identity.
    // Locate the one plugin fiber through Cordis's public runtime registry.
    const runtimes = [...ctx.registry.values()].filter(runtime => runtime.name === 'chatgpt-web')
    assert(runtimes.length === 1 && runtimes[0].fibers.length === 1, 'ChatGPT Web plugin owner fiber is not unique')
    const [ownerFiber] = [...runtimes[0].fibers]
    await ownerFiber.dispose()
    assert(subagents.getProvider(PROVIDER) === undefined, `${PROVIDER} provider remained registered after dispose`)
    assert(tools.get(TOOL) === undefined, `${TOOL} tool remained registered after dispose`)
    checks.registrationsDisposed = true
    assert(ctx.get(PREFERENCES_SERVICE) === undefined, `${PREFERENCES_SERVICE} remained registered after dispose`)
    checks.preferencesDisposed = true
    assert(!(await llm.listProviders()).some(item => item.id === 'solar-chatgpt-web'), 'main Web provider remained registered after dispose')
    checks.mainModelDisposed = true

    finalArtifacts = await runtimeArtifacts(webRoot)
    assert(finalArtifacts.length === 0, `ChatGPT Web runtime artifacts remained after dispose: ${JSON.stringify(finalArtifacts)}`)
    checks.noPersistentArtifacts = true
  } catch (caught) {
    error = serialiseError(caught)
  }

  await writeMarker(markerPath, {
    formatVersion: 1,
    pid: process.pid,
    ok: error === undefined,
    service: SERVICE,
    provider: PROVIDER,
    tool: TOOL,
    checks,
    initialArtifacts,
    finalArtifacts,
    ...(error === undefined ? {} : { error }),
  })
  exit(error === undefined ? 0 : 1)
}

export const name = 'chatgpt-web-plugin-probe'
export const inject = ['appReady', SERVICE, 'subagents', 'tools', 'llm']

export function apply(ctx) {
  const ready = ctx.get('appReady')
  if (ready === undefined || typeof ready.onReady !== 'function') throw new Error('appReady service is unavailable')
  let started = false
  const cancel = ready.onReady(() => {
    if (started) return
    started = true
    void runProbe(ctx).catch(async caught => {
      try {
        const markerPath = requiredEnv('SOLAR_PLUGIN_PROBE_MARKER')
        await writeMarker(markerPath, {
          formatVersion: 1,
          pid: process.pid,
          ok: false,
          service: SERVICE,
          provider: PROVIDER,
          tool: TOOL,
          checks: {},
          error: serialiseError(caught),
        })
      } finally {
        const exit = ctx.get('appExit')
        if (typeof exit === 'function') exit(1)
      }
    })
  })
  return () => cancel()
}
