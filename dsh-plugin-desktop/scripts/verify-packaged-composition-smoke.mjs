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
  const anchoredConfig = join(
    unpackedRoot,
    'vendor',
    'agent-presets',
    'anchored-standard',
    'agent.cordis.yml',
  )

  const [{ prepareDesktopProfile }, { composeEntries }, { createEpochPromotion }] = await Promise.all([
    import(profileModule),
    import(appBootModule),
    import(epochModule),
  ])
  const prepared = prepareDesktopProfile(undefined, temporaryHome, 'darwin')
  const rows = composeEntries([prepared.patches])
  const rowsWithId = id => rows.filter(row => row.id === id)

  const residentRows = rowsWithId('resident-operators')
  const dualModeRows = rowsWithId('physical-operator-dual-mode')
  const teamRows = rowsWithId('agent-teams')
  if (residentRows.length !== 1 || residentRows[0].name !== '@deepseek-ai/dsh-resident-operator-local') {
    throw new Error('verify-packaged-composition-smoke: Resident bundle is not composed exactly once')
  }
  if (dualModeRows.length !== 1 || dualModeRows[0].name !== '@deepseek-ai/dsh-physical-operator-resident') {
    throw new Error('verify-packaged-composition-smoke: physical operator dual-mode router is missing')
  }
  if (teamRows.length !== 1 || teamRows[0].name !== '@nanmicoder/dsh-agent-teams') {
    throw new Error('verify-packaged-composition-smoke: AgentTeams bundle is not composed exactly once')
  }
  if (teamRows[0].config?.memberPersonaPlacement !== 'prompt') {
    throw new Error('verify-packaged-composition-smoke: AgentTeams member persona is not prompt-scoped')
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
      physicalRouter: dualModeRows[0].name,
      agentTeams: teamRows[0].name,
      memberPersonaPlacement: teamRows[0].config.memberPersonaPlacement,
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
