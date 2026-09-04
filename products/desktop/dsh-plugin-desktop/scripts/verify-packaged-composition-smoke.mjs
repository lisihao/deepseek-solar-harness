import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const defaultAppRoot = resolve(import.meta.dirname, '../dist/mac-arm64/DSH Desktop.app')
const appRoot = resolve(process.argv[2] ?? defaultAppRoot)
const appExecutable = join(appRoot, 'Contents', 'MacOS', 'DSH Desktop')

if (process.versions.electron === undefined) {
  if (!existsSync(appExecutable)) {
    throw new Error(`verify-packaged-composition-smoke: packaged application is missing at ${appExecutable}`)
  }
  execFileSync(appExecutable, [scriptPath, appRoot], {
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      HOME: process.env.HOME ?? '',
      PATH: '/usr/bin:/bin',
    },
    stdio: 'inherit',
  })
  process.exit(0)
}

const unpackedRoot = join(appRoot, 'Contents', 'Resources', 'app.asar.unpacked')
const temporaryHome = mkdtempSync('/tmp/dsh-c-')

try {
  const profileModule = pathToFileURL(join(unpackedRoot, 'lib', 'profile.js')).href
  const appBootModule = pathToFileURL(join(
    unpackedRoot,
    'node_modules',
    '@deepseek-ai',
    'dsh-app-boot',
    'lib',
    'index.js',
  )).href
  const epochModule = pathToFileURL(join(
    unpackedRoot,
    'vendor',
    'agent-presets',
    'anchored-standard',
    'compaction-epoch.mjs',
  )).href
  const deepSeekModule = pathToFileURL(join(
    appRoot,
    'Contents',
    'Resources',
    'app.asar',
    'node_modules',
    '@deepseek-ai',
    'dsh-llm-deepseek',
    'lib',
    'index.js',
  )).href
  const anchoredConfig = join(
    unpackedRoot,
    'vendor',
    'agent-presets',
    'anchored-standard',
    'agent.cordis.yml',
  )

  const [{ prepareDesktopProfile }, { composeEntries }, { createEpochPromotion }, { Config: DeepSeekConfig }] = await Promise.all([
    import(profileModule),
    import(appBootModule),
    import(epochModule),
    import(deepSeekModule),
  ])
  const deepSeekModels = DeepSeekConfig({}).models
  const visionModel = deepSeekModels.find(model => model.id === 'deepseek-v4-flash-vision-exp')
  if (!visionModel?.inputModalities?.includes('image')) {
    throw new Error('verify-packaged-composition-smoke: native DeepSeek V4 Flash Vision model is missing image input')
  }
  const prepared = prepareDesktopProfile(undefined, temporaryHome, 'darwin')
  const rows = composeEntries([prepared.patches])
  const rowsWithId = id => rows.filter(row => row.id === id)

  const residentRows = rowsWithId('resident-operators')
  const dualModeRows = rowsWithId('physical-operator-dual-mode')
  const physicalOperatorUiRows = rowsWithId('ui-physical-operator')
  const orchestrationRows = rowsWithId('orchestration-local')
  const orchestrationToolRows = rowsWithId('tool-orchestration')
  const orchestrationUiRows = rowsWithId('ui-orchestration')
  const browserRows = rowsWithId('browser')
  const browserProviderRows = rowsWithId('browser-ego-lite')
  const browserToolRows = rowsWithId('tool-browser')
  const archifyRows = rowsWithId('archify')
  const teamRows = rowsWithId('agent-teams')
  const remoteRows = rowsWithId('remote-web-ui')
  const billingRows = rowsWithId('web-billing')
  const synapseRows = rowsWithId('synapse')
  const remoteModuleRows = rowsWithId('ui-remote-modules')
  if (residentRows.length !== 1 || residentRows[0].name !== '@deepseek-ai/dsh-resident-operator-local') {
    throw new Error('verify-packaged-composition-smoke: Resident bundle is not composed exactly once')
  }
  if (JSON.stringify(residentRows[0].config?.driverModules) !== JSON.stringify([])) {
    throw new Error('verify-packaged-composition-smoke: Resident uses only built-in Claude/Codex subscription drivers')
  }
  if (dualModeRows.length !== 1 || dualModeRows[0].name !== '@deepseek-ai/dsh-physical-operator-resident') {
    throw new Error('verify-packaged-composition-smoke: physical operator dual-mode router is missing')
  }
  if (physicalOperatorUiRows.length !== 1
    || physicalOperatorUiRows[0].name !== '@deepseek-ai/dsh-ui-physical-operator') {
    throw new Error('verify-packaged-composition-smoke: physical operator Web Consumer is not composed exactly once')
  }
  const physicalOperators = dualModeRows[0].config?.operators
  if (!Array.isArray(physicalOperators)
    || !['codex', 'claude-code'].every(id => physicalOperators.some(operator => operator.id === id
      && operator.residentProvider === id))) {
    throw new Error('verify-packaged-composition-smoke: Codex/Claude physical operators are missing')
  }
  if (orchestrationRows.length !== 1
    || orchestrationRows[0].name !== '@deepseek-ai/dsh-orchestration-local'
    || orchestrationRows[0].config?.autoStart !== true) {
    throw new Error('verify-packaged-composition-smoke: durable orchestration Provider is not composed exactly once')
  }
  if (orchestrationToolRows.length !== 1
    || orchestrationToolRows[0].name !== '@deepseek-ai/dsh-tool-orchestration') {
    throw new Error('verify-packaged-composition-smoke: orchestration tool Consumer is not composed exactly once')
  }
  if (orchestrationUiRows.length !== 1
    || orchestrationUiRows[0].name !== '@deepseek-ai/dsh-ui-orchestration') {
    throw new Error('verify-packaged-composition-smoke: orchestration Web Consumer is not composed exactly once')
  }
  if (browserRows.length !== 1
    || browserRows[0].name !== '@deepseek-ai/dsh-browser'
    || browserRows[0].config?.provider !== 'ego-lite') {
    throw new Error('verify-packaged-composition-smoke: provider-neutral browser seam is not composed exactly once')
  }
  if (browserProviderRows.length !== 1 || browserProviderRows[0].name !== '@deepseek-ai/dsh-browser-ego-lite') {
    throw new Error('verify-packaged-composition-smoke: Ego Lite browser Provider is not composed exactly once')
  }
  if (browserToolRows.length !== 1 || browserToolRows[0].name !== '@deepseek-ai/dsh-tool-browser') {
    throw new Error('verify-packaged-composition-smoke: browser tool Consumer is not composed exactly once')
  }
  if (archifyRows.length !== 1 || archifyRows[0].name !== '@deepseek-ai/dsh-archify') {
    throw new Error('verify-packaged-composition-smoke: Archify bundle is not composed exactly once')
  }
  if (teamRows.length !== 1 || teamRows[0].name !== '@nanmicoder/dsh-agent-teams') {
    throw new Error('verify-packaged-composition-smoke: AgentTeams bundle is not composed exactly once')
  }
  if (teamRows[0].config?.memberPersonaPlacement !== 'prompt') {
    throw new Error('verify-packaged-composition-smoke: AgentTeams member persona is not prompt-scoped')
  }
  if (remoteRows.length !== 1 || remoteRows[0].name !== '@linxin666/dsh-remote-web-ui') {
    throw new Error('verify-packaged-composition-smoke: Remote Web UI bundle is not composed exactly once')
  }
  if (billingRows.length !== 1 || billingRows[0].name !== 'dsh-web-billing') {
    throw new Error('verify-packaged-composition-smoke: Billing bundle is not composed exactly once')
  }
  if (synapseRows.length !== 1 || synapseRows[0].name !== 'dsh-synapse') {
    throw new Error('verify-packaged-composition-smoke: Synapse bundle is not composed exactly once')
  }
  for (const [id, name] of [
    ['genui', '@omdsh-dev/dsh-genui'],
    ['tool-plugin-check', '@omdsh-dev/dsh-plugin-check'],
    ['llm-fallbacks', 'dsh-llm-fallbacks'],
    ['tool-stat', '@deepseek-ai/dsh-tool-stat'],
    ['tool-time', '@deepseek-ai/dsh-tool-time'],
    ['tool-regex', '@deepseek-ai/dsh-tool-regex'],
    ['tool-markdown', '@deepseek-ai/dsh-tool-markdown'],
    ['codegraph', 'dsh-codegraph'],
    ['mnemon', 'dsh-mnemon'],
    ['aegis-method-pack', 'aegis/extensions/dsh/index.js'],
    ['better-sidebar', 'dsh-better-sidebar'],
  ]) {
    const matching = rowsWithId(id)
    if (matching.length !== 1 || matching[0].name !== name) {
      throw new Error(`verify-packaged-composition-smoke: ${id} bundle is not composed exactly once`)
    }
  }
  if (rowsWithId('luna-vision-bridge').length !== 0 || rowsWithId('dsh-memory-evolve').length !== 0) {
    throw new Error('verify-packaged-composition-smoke: retired Luna/Memory Evolve rows remain in the default product')
  }
  if (remoteModuleRows.length !== 1
    || remoteModuleRows[0].name !== '@deepseek-ai/dsh-client-ui-remote-modules'
    || remoteModuleRows[0].disabled === true) {
    throw new Error('verify-packaged-composition-smoke: configurable Remote Modules bundle is not enabled exactly once')
  }
  const remoteInstances = remoteModuleRows[0].config?.instances
  if (!Array.isArray(remoteInstances) || remoteInstances.length !== 0) {
    throw new Error('verify-packaged-composition-smoke: public Desktop must ship without private Remote Module targets')
  }

  const presetRow = rowsWithId('agent-presets')[0]
  const roots = presetRow?.config?.roots
  if (!Array.isArray(roots) || !String(roots[0]?.path).includes('vendor/agent-presets')) {
    throw new Error('verify-packaged-composition-smoke: packaged presets do not precede shipped presets')
  }

  const subagent = {
    session: {
      id: 'packaged-worker',
      header: { delegationDepth: 1 },
      events: [],
    },
  }
  const anchoredTracker = createEpochPromotion(['tool/call'], { includeSubagents: true })
  const legacyTracker = createEpochPromotion(['tool/call'])
  if (anchoredTracker.status(subagent).promoted !== false) {
    throw new Error('verify-packaged-composition-smoke: Anchored Standard does not gate worker request one')
  }
  if (legacyTracker.status(subagent).promoted !== true) {
    throw new Error('verify-packaged-composition-smoke: smoke fixture cannot distinguish the old worker behavior')
  }

  const configText = readFileSync(anchoredConfig, 'utf8')
  if (!configText.includes('bootstrapTools: [bash, str_replace_editor]')) {
    throw new Error('verify-packaged-composition-smoke: Anchored Standard bootstrap tool pair changed')
  }

  process.stdout.write(`${JSON.stringify({
    electron: process.versions.electron,
    executable: process.execPath,
    productRows: {
      resident: residentRows[0].name,
      residentDriverModules: residentRows[0].config.driverModules,
      physicalRouter: dualModeRows[0].name,
      physicalOperatorUi: physicalOperatorUiRows[0].name,
      physicalOperators: physicalOperators.map(operator => operator.id),
      orchestrationProvider: orchestrationRows[0].name,
      orchestrationTool: orchestrationToolRows[0].name,
      orchestrationUi: orchestrationUiRows[0].name,
      browser: browserRows[0].name,
      browserProvider: browserProviderRows[0].name,
      browserTool: browserToolRows[0].name,
      archify: archifyRows[0].name,
      agentTeams: teamRows[0].name,
      memberPersonaPlacement: teamRows[0].config.memberPersonaPlacement,
      remoteWebUi: remoteRows[0].name,
      billing: billingRows[0].name,
      synapse: synapseRows[0].name,
      deepSeekVisionModel: visionModel.id,
      deepSeekVisionModalities: visionModel.inputModalities,
      remoteModules: remoteModuleRows[0].name,
      remoteModuleInstances: remoteInstances.map(instance => instance.id),
    },
    anchoredStandard: {
      presetRoot: roots[0].path,
      workerFirstTurnPromoted: anchoredTracker.status(subagent).promoted,
      bootstrapTools: ['bash', 'str_replace_editor'],
    },
  }, undefined, 2)}\n`)
} finally {
  rmSync(temporaryHome, { recursive: true, force: true })
}
