#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { execFile as execFileCallback, spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFile = promisify(execFileCallback)

const FORMAT_VERSION = 1
const REPOSITORY = 'https://github.com/PrimeIntellect-ai/arc-agi-3-prime-agent'
const COMMIT = '398d4dd63cf01d00adbea41c13437ba0b8ad40fc'
const COMMIT_URL = `${REPOSITORY}/commit/${COMMIT}`
const DEFAULT_SOURCE = '/private/tmp/dsh-rlm-arc-reference-398d4dd'
const ADAPTER_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/rlm-arc-prepare/sdk-step-adapter.py')
const REQUIRED_SOURCE_FILES = [
  'README.md',
  'AGENTS.md',
  'game-prompt.txt',
  'run.sh',
  'arc3_local_broker.py',
  'broker_client.py',
  'game_protocol_guard.py',
  'pyproject.toml',
  'results/results.json',
  '.env.example',
  'LICENSE',
]
const ARC_AGI_VERSION = '0.9.9'
const ARCENGINE_VERSION = '0.9.3'
const MAX_ACTIONS = 500
const MAX_BATCH = 20

function fail(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  throw error
}

function usage() {
  return [
    'Usage:',
    '  node tools/rlm-arc-prepare.mjs                 # read-only preflight',
    '  node tools/rlm-arc-prepare.mjs --prepare --output <new-private-tmpdir>',
    '',
    'Options:',
    `  --source <path>   pinned author checkout (default: ${DEFAULT_SOURCE})`,
    '  --prepare         clone/verify, install fixed Toolkit, download once, and smoke-test',
    '  --output <path>   new absolute directory under /private/tmp (required with --prepare)',
    '  --smoke-existing <path>  verify an existing prepare output and create a new local smoke receipt',
    '  --compat-step     use the explicit arc-agi step facade (only with --smoke-existing)',
  ].join('\n')
}

function parseArgs(argv) {
  let mode = 'preflight'
  let source = DEFAULT_SOURCE
  let output
  let existing
  let compatStep = false
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item === '--help' || item === '-h') {
      console.log(usage())
      process.exit(0)
    }
    if (item === '--prepare') {
      if (mode === 'prepare') fail('ARC_ARGS', '--prepare was provided twice')
      mode = 'prepare'
      continue
    }
    if (item === '--preflight') {
      if (mode === 'prepare') fail('ARC_ARGS', '--preflight cannot be combined with --prepare')
      mode = 'preflight'
      continue
    }
    if (item === '--compat-step') {
      compatStep = true
      continue
    }
    if (item === '--source' || item === '--output' || item === '--smoke-existing') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) fail('ARC_ARGS', `${item} requires a value`)
      if (item === '--source') source = resolve(value)
      else if (item === '--output') output = resolve(value)
      else {
        existing = resolve(value)
        mode = 'smoke-existing'
      }
      index += 1
      continue
    }
    fail('ARC_ARGS', `unknown option ${item}`)
  }
  if (mode === 'prepare' && !output) fail('ARC_ARGS', '--prepare requires --output')
  if (mode === 'prepare' && existing) fail('ARC_ARGS', '--prepare cannot be combined with --smoke-existing')
  if (mode === 'smoke-existing' && output) fail('ARC_ARGS', '--output cannot be combined with --smoke-existing')
  if (mode === 'smoke-existing' && !existing) fail('ARC_ARGS', '--smoke-existing requires a path')
  if (mode === 'preflight' && (output || existing)) fail('ARC_ARGS', 'output options are only valid with --prepare or --smoke-existing')
  if (compatStep && mode !== 'smoke-existing') fail('ARC_ARGS', '--compat-step requires --smoke-existing')
  if (output && !isPrivateTempPath(output)) fail('ARC_OUTPUT_SCOPE', '--output must be a new directory under /private/tmp')
  if (existing && !isPrivateTempPath(existing)) fail('ARC_OUTPUT_SCOPE', '--smoke-existing must point under /private/tmp')
  return { mode, source, output, existing, compatStep }
}

function isPrivateTempPath(path) {
  const resolved = resolve(path)
  return resolved.startsWith('/private/tmp/') && resolved !== '/private/tmp'
}

function redact(text) {
  return String(text ?? '')
    .replace(/(arc[_-]?api[_-]?key|anthropic[_-]?api[_-]?key|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .slice(0, 4_000)
}

function cleanEnv(root, extra = {}) {
  const pathValue = process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'
  return {
    PATH: pathValue,
    HOME: join(root, 'runtime-home'),
    TMPDIR: join(root, 'runtime-tmp'),
    MPLCONFIGDIR: join(root, 'runtime-mpl'),
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PYTHONDONTWRITEBYTECODE: '1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    UV_NO_PROGRESS: '1',
    UV_CACHE_DIR: join(root, 'uv-cache'),
    ...extra,
  }
}

async function pathExists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function isDirectory(path) {
  try {
    return (await lstat(path)).isDirectory()
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function command(command, args, options = {}) {
  try {
    return await execFile(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout,
      maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    })
  } catch (error) {
    const stdout = redact(error.stdout)
    const stderr = redact(error.stderr)
    const detail = [stderr, stdout].filter(Boolean).join(' | ')
    const message = `${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`
    const wrapped = new Error(message)
    wrapped.code = 'ARC_COMMAND'
    wrapped.command = command
    wrapped.args = args
    wrapped.exitCode = error.code
    wrapped.stdout = stdout
    wrapped.stderr = stderr
    throw wrapped
  }
}

async function sha256File(path) {
  const hash = createHash('sha256')
  const bytes = await readFile(path)
  hash.update(bytes)
  return { sha256: hash.digest('hex'), size: bytes.byteLength }
}

async function writePrivate(path, content) {
  await writeFile(path, content, { mode: 0o600, flag: 'wx' })
}

async function writeJson(path, value) {
  await writePrivate(path, `${JSON.stringify(value, null, 2)}\n`)
}

function sourceError(error) {
  return { code: error.code ?? 'ARC_SOURCE', message: redact(error.message) }
}

async function ensureSource(source, { allowClone }) {
  const sourcePath = resolve(source)
  if (!(await pathExists(sourcePath))) {
    if (!allowClone) fail('ARC_SOURCE_MISSING', `pinned checkout is absent: ${sourcePath}`)
    if (!isPrivateTempPath(sourcePath)) fail('ARC_SOURCE_SCOPE', 'automatic clone target must be under /private/tmp')
    await command('git', ['clone', REPOSITORY, sourcePath], {
      cwd: '/private/tmp',
      env: cleanEnv('/private/tmp/dsh-rlm-arc-clone-runtime'),
    })
    await command('git', ['-C', sourcePath, 'checkout', '--detach', COMMIT], {
      cwd: sourcePath,
      env: cleanEnv('/private/tmp/dsh-rlm-arc-clone-runtime'),
    })
  }
  const sourceStat = await lstat(sourcePath)
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) fail('ARC_SOURCE_PATH', `source is not a real directory: ${sourcePath}`)
  const sourceReal = await realpath(sourcePath)
  const root = (await command('git', ['-C', sourceReal, 'rev-parse', '--show-toplevel'], { env: cleanEnv('/private/tmp/dsh-rlm-arc-git-runtime') })).stdout.trim()
  if (resolve(root) !== sourceReal) fail('ARC_SOURCE_PATH', `git root does not match source: ${root}`)
  const commit = (await command('git', ['-C', sourceReal, 'rev-parse', '--verify', 'HEAD'], { env: cleanEnv('/private/tmp/dsh-rlm-arc-git-runtime') })).stdout.trim()
  if (commit !== COMMIT) fail('ARC_SOURCE_WRONGPIN', `expected ${COMMIT}, found ${commit}`)
  const status = (await command('git', ['-C', sourceReal, 'status', '--porcelain=v1', '--untracked-files=all'], { env: cleanEnv('/private/tmp/dsh-rlm-arc-git-runtime') })).stdout.trim()
  if (status) fail('ARC_SOURCE_DIRTY', `pinned author checkout is dirty: ${redact(status)}`)
  const remote = (await command('git', ['-C', sourceReal, 'remote', 'get-url', 'origin'], { env: cleanEnv('/private/tmp/dsh-rlm-arc-git-runtime') })).stdout.trim()
  if (remote !== REPOSITORY && remote !== `${REPOSITORY}.git`) fail('ARC_SOURCE_REMOTE', `origin is not the pinned author repository: ${remote}`)
  const commitDate = (await command('git', ['-C', sourceReal, 'show', '-s', '--format=%cI', 'HEAD'], { env: cleanEnv('/private/tmp/dsh-rlm-arc-git-runtime') })).stdout.trim()
  const listed = (await command('git', ['-C', sourceReal, 'ls-files', '-z'], { env: cleanEnv('/private/tmp/dsh-rlm-arc-git-runtime') })).stdout.split('\0').filter(Boolean)
  const files = []
  for (const relativePath of listed) {
    const filePath = join(sourceReal, relativePath)
    const fileStat = await lstat(filePath)
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) fail('ARC_SOURCE_FILE', `tracked file is not a regular file: ${relativePath}`)
    const digest = await sha256File(filePath)
    files.push({ path: relativePath.split(sep).join('/'), ...digest })
  }
  for (const required of REQUIRED_SOURCE_FILES) {
    if (!files.some(file => file.path === required)) fail('ARC_SOURCE_FILE', `required source file is missing: ${required}`)
  }
  const resultPath = join(sourceReal, 'results/results.json')
  const results = JSON.parse(await readFile(resultPath, 'utf8'))
  const run1 = results?.runs?.['run-1']
  if (!Array.isArray(run1?.games) || run1.games.length !== 25) fail('ARC_RESULTS', 'run-1 must contain exactly 25 games')
  const games = run1.games.map((game, index) => {
    if (typeof game?.game_id !== 'string' || !/^[^-]+-[^-]+$/.test(game.game_id)) fail('ARC_RESULTS', `invalid game_id at run-1.games[${index}]`)
    const [baseId, version] = game.game_id.split('-', 2)
    return { requestedGameId: game.game_id, requestedBaseId: baseId, requestedVersion: version }
  })
  if (new Set(games.map(game => game.requestedGameId)).size !== 25) fail('ARC_RESULTS', 'run-1 game IDs are not unique')
  const runIds = {}
  for (const [runName, run] of Object.entries(results.runs ?? {})) {
    runIds[runName] = Array.isArray(run?.games) ? run.games.map(game => game.game_id) : []
  }
  return {
    path: sourceReal,
    repository: REPOSITORY,
    commit,
    commitUrl: COMMIT_URL,
    commitDate,
    origin: remote,
    clean: true,
    files,
    requiredFiles: REQUIRED_SOURCE_FILES,
    results: {
      method: results.method ?? null,
      protocol: results.protocol ?? null,
      games,
      runs: runIds,
    },
  }
}

function preflightReport(source, details, blockers = []) {
  return {
    formatVersion: FORMAT_VERSION,
    mode: 'preflight',
    generatedAt: new Date().toISOString(),
    sideEffects: { network: false, install: false, modelCalls: 0, outputCreated: false },
    source: details
      ? { repository: details.repository, commit: details.commit, commitUrl: details.commitUrl, checkout: details.path, clean: details.clean, files: details.files, requiredFiles: details.requiredFiles }
      : { repository: REPOSITORY, commit: COMMIT, commitUrl: COMMIT_URL, checkout: source, clean: null },
    expected: {
      dependency: { python: '>=3.12', arcAgi: ARC_AGI_VERSION, arcengine: ARCENGINE_VERSION },
      corpus: '25 exact game_id/version entries parsed from results/results.json; no latest fallback',
      broker: { actionsPerGame: MAX_ACTIONS, maxBatch: MAX_BATCH, smokeSteps: 2 },
      guard: 'not run; Linux root/SO_PEERCRED guard is outside this macOS keyless smoke',
    },
    games: details?.results?.games ?? [],
    blockers,
  }
}

const DOWNLOAD_HELPER = String.raw`#!/usr/bin/env python3
"""One-shot ARC Toolkit download helper; stdout and report contain no API key."""
from __future__ import annotations

import hashlib
import json
import logging
import sys
from pathlib import Path

from arc_agi import Arcade, OperationMode
import arc_agi.base as base


def safe_message(value: object) -> str:
    text = str(value)
    for marker in ("arc_api_key", "api_key", "authorization", "bearer"):
        text = text.replace(marker, f"{marker}=[redacted]")
    return text[:4000]


def event_kind(url: str) -> str:
    if url.endswith("/api/games/anonkey"):
        return "anonkey"
    if url.endswith("/api/games"):
        return "list"
    if url.endswith("/source"):
        return "source"
    return "metadata"


events: list[dict[str, object]] = []
original_get = base.requests.get


def tracked_get(url, *args, **kwargs):
    kind = event_kind(str(url))
    try:
        response = original_get(url, *args, **kwargs)
    except Exception as exc:
        events.append({"kind": kind, "url": str(url), "errorType": type(exc).__name__, "error": safe_message(exc)})
        raise
    events.append({"kind": kind, "url": str(url), "status": int(response.status_code)})
    return response


base.requests.get = tracked_get

corpus = Path(sys.argv[1]).resolve()
games_path = Path(sys.argv[2]).resolve()
result_path = Path(sys.argv[3]).resolve()
requested = json.loads(games_path.read_text(encoding="utf-8"))
game_results: dict[str, dict[str, object]] = {}
for game in requested:
    game_results[game["requestedGameId"]] = {"requestedGameId": game["requestedGameId"], "requestedBaseId": game["requestedBaseId"], "requestedVersion": game["requestedVersion"], "makeReturned": False, "error": None, "events": []}

logger = logging.getLogger("dsh-rlm-arc-prepare")
logger.disabled = True
arcade = None
initialization_error = None
try:
    arcade = Arcade(operation_mode=OperationMode.NORMAL, environments_dir=str(corpus), recordings_dir=str(corpus.parent / "recordings"), logger=logger)
except Exception as exc:
    initialization_error = {"type": type(exc).__name__, "message": safe_message(exc)}

if arcade is not None:
    for game in requested:
        game_id = game["requestedGameId"]
        before = len(events)
        entry = game_results[game_id]
        try:
            value = arcade.make(game_id, seed=0, save_recording=False, include_frame_data=False)
            entry["makeReturned"] = value is not None
        except Exception as exc:
            entry["error"] = {"type": type(exc).__name__, "message": safe_message(exc)}
        entry["events"] = events[before:]

anonymous = [event for event in events if event.get("kind") == "anonkey"]
result = {
    "toolkit": {"package": "arc-agi", "version": "0.9.9", "operationMode": "normal", "anonymousKey": {"attempted": bool(anonymous), "succeeded": any(event.get("status") == 200 for event in anonymous)}},
    "initialization": {"ok": arcade is not None, "error": initialization_error},
    "events": events,
    "games": game_results,
}
result_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"resultPath": str(result_path), "eventCount": len(events), "gameCount": len(game_results)}, separators=(",", ":")))
`

async function setupDependencies(output) {
  const venv = join(output, 'venv')
  const env = cleanEnv(output)
  await mkdir(join(output, 'runtime-home'), { recursive: true, mode: 0o700 })
  await mkdir(join(output, 'runtime-tmp'), { recursive: true, mode: 0o700 })
  await mkdir(join(output, 'runtime-mpl'), { recursive: true, mode: 0o700 })
  await command('uv', ['venv', '--python', '3.12', venv], { cwd: output, env })
  const python = join(venv, 'bin/python')
  await command('uv', ['pip', 'install', '--python', python, `arc-agi==${ARC_AGI_VERSION}`, `arcengine==${ARCENGINE_VERSION}`], { cwd: output, env })
  const versionCode = [
    'import importlib.metadata as m, json, platform, sys',
    'print(json.dumps({"python": platform.python_version(), "arc_agi": m.version("arc-agi"), "arcengine": m.version("arcengine")}, separators=(",", ":")))',
  ].join('; ')
  const versions = JSON.parse((await command(python, ['-c', versionCode], { cwd: output, env, maxBuffer: 1_000_000 })).stdout.trim())
  const freeze = (await command('uv', ['pip', 'freeze', '--python', python], { cwd: output, env, maxBuffer: 4 * 1024 * 1024 })).stdout
  await writePrivate(join(output, 'dependencies.freeze.txt'), freeze)
  const uvVersion = (await command('uv', ['--version'], { cwd: output, env, maxBuffer: 1_000_000 })).stdout.trim()
  return { venv, python, uv: uvVersion, versions, freezePath: join(output, 'dependencies.freeze.txt') }
}

async function inspectDownloadedGame(corpus, game) {
  const directory = join(corpus, game.requestedBaseId, game.requestedVersion)
  const metadataPath = join(directory, 'metadata.json')
  let metadata = null
  try {
    metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') return { directory, metadata: null, metadataError: redact(error.message), files: [] }
  }
  const files = []
  if (metadata && await pathExists(metadataPath)) files.push({ path: relative(corpus, metadataPath).split(sep).join('/'), ...(await sha256File(metadataPath)) })
  if (await isDirectory(directory)) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || !entry.name.endsWith('.py')) continue
      const path = join(directory, entry.name)
      files.push({ path: relative(corpus, path).split(sep).join('/'), ...(await sha256File(path)) })
    }
  }
  const metadataGameId = metadata?.game_id ?? null
  const metadataVersion = metadata?.version ?? (typeof metadataGameId === 'string' && metadataGameId.includes('-') ? metadataGameId.split('-', 2)[1] : null)
  const exact = metadataGameId === game.requestedGameId || (metadataGameId === game.requestedBaseId && metadataVersion === game.requestedVersion) || metadataVersion === game.requestedVersion
  return { directory, metadata, metadataGameId, metadataVersion, exact, files }
}

function statusForGame(raw, inspected) {
  const statuses = (raw?.events ?? []).map(event => event.status).filter(status => Number.isInteger(status))
  if (inspected?.exact && inspected.files.some(file => file.path.endsWith('.py'))) return 'available'
  if (statuses.includes(403)) return 'http_403'
  if (statuses.includes(404)) return 'http_404'
  if (raw?.error) return 'error'
  return 'missing'
}

async function downloadCorpus(output, sourceDetails, dependencies) {
  const corpus = join(output, 'corpus')
  await mkdir(corpus, { recursive: true, mode: 0o700 })
  const gamesPath = join(output, 'requested-games.json')
  const helperPath = join(output, 'download-corpus.py')
  const rawResultPath = join(output, 'download-result.json')
  await writeJson(gamesPath, sourceDetails.results.games)
  await writePrivate(helperPath, DOWNLOAD_HELPER)
  const helperEnv = cleanEnv(output, { OPERATION_MODE: 'normal' })
  let helperError = null
  try {
    await command(dependencies.python, [helperPath, corpus, gamesPath, rawResultPath], { cwd: output, env: helperEnv, maxBuffer: 4 * 1024 * 1024 })
  } catch (error) {
    helperError = sourceError(error)
  }
  let raw = null
  if (await pathExists(rawResultPath)) {
    try {
      raw = JSON.parse(await readFile(rawResultPath, 'utf8'))
    } catch (error) {
      helperError ??= { code: 'ARC_DOWNLOAD_JSON', message: redact(error.message) }
    }
  }
  const games = []
  for (const game of sourceDetails.results.games) {
    const rawGame = raw?.games?.[game.requestedGameId] ?? { requestedGameId: game.requestedGameId, requestedBaseId: game.requestedBaseId, requestedVersion: game.requestedVersion, events: [], error: helperError }
    const inspected = await inspectDownloadedGame(corpus, game)
    games.push({
      ...game,
      requestMode: 'exact_game_id_with_version',
      status: statusForGame(rawGame, inspected),
      metadataGameId: inspected.metadataGameId ?? null,
      metadataVersion: inspected.metadataVersion ?? null,
      metadata: inspected.metadata ? { title: inspected.metadata.title ?? null, className: inspected.metadata.class_name ?? null } : null,
      files: inspected.files,
      makeReturned: rawGame.makeReturned ?? false,
      httpEvents: rawGame.events ?? [],
      error: rawGame.error ?? inspected.metadataError ?? null,
    })
  }
  return {
    corpus,
    helperPath,
    rawResultPath,
    initialization: raw?.initialization ?? { ok: false, error: helperError },
    toolkit: raw?.toolkit ?? { package: 'arc-agi', version: ARC_AGI_VERSION, operationMode: 'normal', anonymousKey: { attempted: false, succeeded: false } },
    events: raw?.events ?? [],
    games,
    helperError,
  }
}

function frameShape(value, depth = 0) {
  if (!Array.isArray(value) || depth >= 4) return []
  return [value.length, ...(value.length > 0 ? frameShape(value[0], depth + 1) : [])]
}

function frameSummary(value) {
  const frame = value?.frame
  if (!Array.isArray(frame)) return { frameCount: null, frameShapes: [], frameSha256: null }
  return {
    frameCount: frame.length,
    frameShapes: frame.map(item => frameShape(item)),
    frameSha256: createHash('sha256').update(JSON.stringify(frame)).digest('hex'),
  }
}

function valueSummary(value) {
  if (!value || typeof value !== 'object') return { valueType: typeof value }
  return {
    gameId: value.game_id ?? null,
    state: value.state ?? null,
    terminal: value.terminal ?? null,
    levelsCompleted: value.levels_completed ?? null,
    availableActions: Array.isArray(value.available_actions) ? value.available_actions : [],
    actionsTaken: value.actions_taken ?? null,
    actionsRemaining: value.actions_remaining ?? null,
    ...frameSummary(value),
  }
}

function pickAction(value) {
  const actions = Array.isArray(value?.available_actions) ? value.available_actions.filter(action => Number.isInteger(action) && action >= 1 && action <= 7) : []
  const number = actions.find(action => action !== 6) ?? actions[0]
  if (!number) return null
  return number === 6 ? { name: 'ACTION6', data: { x: 32, y: 32 } } : { name: `ACTION${number}`, data: {} }
}

async function runClientOperation(sourceDetails, dependencies, smoke, operation, actions = null) {
  const args = [join(sourceDetails.path, 'broker_client.py'), operation]
  if (actions !== null) args.push('--actions', JSON.stringify(actions))
  const env = cleanEnv(smoke.output, {
    ARC3_GAME_BROKER_SOCKET: smoke.socket,
    ARC3_STATE: smoke.clientState,
  })
  const result = await command(dependencies.python, args, { cwd: smoke.output, env, timeout: operation === 'act' ? 30_000 : 10_000, maxBuffer: 64 * 1024 * 1024 })
  const stdout = result.stdout.trim()
  try {
    return JSON.parse(stdout)
  } catch (error) {
    fail('ARC_CLIENT_JSON', `broker_client.py ${operation} returned invalid JSON: ${redact(error.message)}`)
  }
}

async function waitForSocket(path, child, timeoutMs = 20_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await pathExists(path)) return
    if (child.exitCode !== null) fail('ARC_BROKER_EXIT', `broker exited before socket creation with code ${child.exitCode}`)
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  fail('ARC_BROKER_TIMEOUT', `broker socket was not created within ${timeoutMs}ms`)
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return { exitCode: child.exitCode, signal: child.signalCode, killed: child.killed, timedOut: false }
  const wait = async (timeoutMs) => {
    if (child.exitCode !== null || child.signalCode !== null) return true
    return await new Promise(resolvePromise => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolvePromise(true)
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.removeListener('exit', finish)
        resolvePromise(false)
      }, timeoutMs)
      child.once('exit', finish)
    })
  }
  const signalGroup = signal => {
    if (child.pid === undefined) return false
    try {
      process.kill(-child.pid, signal)
      return true
    } catch {
      return child.kill(signal)
    }
  }
  signalGroup('SIGTERM')
  if (!(await wait(5_000)) && child.exitCode === null && child.signalCode === null) {
    signalGroup('SIGKILL')
    await wait(5_000)
  }
  return { exitCode: child.exitCode, signal: child.signalCode, killed: child.killed, timedOut: child.exitCode === null && child.signalCode === null }
}

async function runBrokerSmoke(output, sourceDetails, dependencies, download, options = {}) {
  const available = download.games.find(game => game.status === 'available')
  const compatibilityAdapter = options.compatibilityAdapter === true
  const smokeOutput = options.smokeOutput ?? join(output, 'smoke')
  const brokerProgram = options.brokerProgram ?? join(sourceDetails.path, 'arc3_local_broker.py')
  const result = {
    mode: compatibilityAdapter ? 'compatible-adapter' : 'original-broker',
    attempted: false,
    modelCalls: 0,
    selectedGameId: available?.requestedGameId ?? null,
    exactAuthorReproduction: false,
    authorBrokerUnmodified: true,
    scope: { transport: 'author broker_client.py over Unix socket', clientPhaseBootstrap: 'planned', protocolGuard: 'not_run' },
    receipts: [],
    actionErrors: [],
    cleanup: { brokerStopped: false, socketRemoved: false, exitCode: null },
    blocker: null,
  }
  if (compatibilityAdapter) {
    result.compatibilityAdapter = {
      path: ADAPTER_PATH,
      mode: 'facade-only dispatch adaptation',
      exactAuthorReproduction: false,
      reason: 'the pinned broker calls actionN methods while arc-agi 0.9.9 exposes step(GameAction, data)',
      preservedBrokerLogic: ['500 action cap', '20-action batch limit', 'GAME_OVER consumes one RESET', 'WIN/level-change batch termination'],
    }
  }
  if (!available) {
    result.scope.clientPhaseBootstrap = 'not_run_no_downloaded_game'
    result.blocker = 'no exact game corpus entry was available for offline smoke'
    return result
  }
  result.attempted = true
  await mkdir(smokeOutput, { recursive: true, mode: 0o700 })
  const socket = join(smokeOutput, 'broker.sock')
  const clientState = join(smokeOutput, 'client-state')
  await mkdir(clientState, { recursive: true, mode: 0o700 })
  const stdoutPath = join(smokeOutput, 'broker.stdout.log')
  const stderrPath = join(smokeOutput, 'broker.stderr.log')
  const brokerArgs = options.brokerArgs ?? ['--game', available.requestedGameId, '--corpus', download.corpus, '--socket', socket]
  const child = spawn(dependencies.python, [brokerProgram, ...brokerArgs], {
    cwd: smokeOutput,
    env: cleanEnv(output, { OPERATION_MODE: 'offline' }),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout = createWriteStream(stdoutPath, { mode: 0o600 })
  const stderr = createWriteStream(stderrPath, { mode: 0o600 })
  child.stdout.pipe(stdout)
  child.stderr.pipe(stderr)
  try {
    await waitForSocket(socket, child)
    const smoke = { output: smokeOutput, socket, clientState }
    let current
    try {
      current = await runClientOperation(sourceDetails, dependencies, smoke, 'observe')
      result.receipts.push({ operation: 'observe', value: valueSummary(current) })
      for (let index = 0; index < 2; index += 1) {
        if (current?.terminal && current.terminal !== 'ACTIVE') break
        const action = pickAction(current)
        if (!action) {
          result.blocker = `no valid available action for smoke step ${index + 1}`
          break
        }
        try {
          current = await runClientOperation(sourceDetails, dependencies, smoke, 'act', [action])
          result.receipts.push({ operation: 'act', step: index + 1, action, value: valueSummary(current) })
        } catch (error) {
          const failure = { step: index + 1, action, error: sourceError(error) }
          result.actionErrors.push(failure)
          result.clientError = failure.error
          result.blocker = result.blocker ?? failure.error
          break
        }
      }
      try {
        const status = await runClientOperation(sourceDetails, dependencies, smoke, 'status')
        result.receipts.push({ operation: 'status', value: valueSummary(status) })
      } catch (error) {
        result.statusError = sourceError(error)
        result.blocker = result.blocker ?? result.statusError
      }
      result.scope.clientPhaseBootstrap = result.actionErrors.length === 0 && !result.statusError
        ? 'observe_then_two_single_actions_status'
        : result.actionErrors.length > 0
          ? 'observe_then_action_failure_status_attempted'
          : 'observe_then_two_single_actions_status_failed'
      const final = [...result.receipts].reverse().find(receipt => receipt.value)?.value
      result.actionCap = MAX_ACTIONS
      result.finalActionsTaken = final?.actionsTaken ?? null
      result.belowActionCap = Number.isInteger(result.finalActionsTaken) && result.finalActionsTaken < MAX_ACTIONS
      result.frameReceipt = result.receipts.map(receipt => ({ operation: receipt.operation, step: receipt.step ?? null, frameCount: receipt.value?.frameCount ?? null, frameShapes: receipt.value?.frameShapes ?? [], frameSha256: receipt.value?.frameSha256 ?? null, actionsTaken: receipt.value?.actionsTaken ?? null }))
      if (!result.belowActionCap) result.blocker = result.blocker ?? 'smoke did not produce an action count below the 500-action cap'
      if (result.actionErrors.length === 0 && !result.statusError && result.receipts.filter(receipt => receipt.operation === 'act').length === 2) result.exactAuthorReproduction = false
    } catch (error) {
      result.blocker = sourceError(error)
      result.clientError = result.blocker
      result.scope.clientPhaseBootstrap = 'failed'
    }
  } catch (error) {
    result.blocker = sourceError(error)
    result.clientError = result.blocker
    result.scope.clientPhaseBootstrap = 'failed_before_observe'
  } finally {
    try {
      const stopped = await stopChild(child)
      result.cleanup.exitCode = stopped.exitCode
      result.cleanup.signal = stopped.signal
      result.cleanup.killRequested = stopped.killed
      result.cleanup.brokerStopped = !stopped.timedOut
      if (stopped.timedOut) result.cleanup.error = { code: 'ARC_BROKER_STOP_TIMEOUT', message: 'owned broker process did not report exit after SIGTERM/SIGKILL' }
    } catch (error) {
      result.cleanup.error = sourceError(error)
    }
    try {
      if (await pathExists(socket)) {
        const socketInfo = await lstat(socket)
        if (socketInfo.isSocket()) await unlink(socket)
      }
      result.cleanup.socketRemoved = !(await pathExists(socket))
    } catch (error) {
      result.cleanup.socketError = sourceError(error)
    }
    for (const stream of [stdout, stderr]) {
      if (stream.closed) continue
      await new Promise(resolvePromise => {
        stream.once('close', resolvePromise)
        stream.end()
      })
    }
    try {
      const receiptsPath = join(smokeOutput, 'broker-receipts.json')
      await writeJson(receiptsPath, result.receipts)
      result.receiptsPath = receiptsPath
      result.receiptsSha256 = (await sha256File(receiptsPath)).sha256
    } catch (error) {
      result.receiptsError = sourceError(error)
    }
    result.logs = { stdout: stdoutPath, stderr: stderrPath }
  }
  return result
}

function sameFileManifest(left, right) {
  const normalize = value => (value ?? []).map(file => ({ path: file.path, sha256: file.sha256, size: file.size })).sort((a, b) => a.path.localeCompare(b.path))
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right))
}

async function verifyExisting(existing) {
  if (!(await isDirectory(existing))) fail('ARC_EXISTING_PATH', `existing output is not a directory: ${existing}`)
  const reportPath = join(existing, 'report.json')
  if (!(await pathExists(reportPath))) fail('ARC_EXISTING_REPORT', `existing output has no report.json: ${reportPath}`)
  const originalReport = JSON.parse(await readFile(reportPath, 'utf8'))
  if (originalReport.mode !== 'prepare') fail('ARC_EXISTING_REPORT', 'existing report is not a prepare report')
  const sourcePath = originalReport.source?.checkout
  if (typeof sourcePath !== 'string') fail('ARC_EXISTING_SOURCE', 'existing report has no source checkout')
  const sourceDetails = await ensureSource(sourcePath, { allowClone: false })
  const verification = {
    reportPath,
    source: { commit: sourceDetails.commit, clean: sourceDetails.clean, expectedCommit: COMMIT, commitMatch: sourceDetails.commit === COMMIT, filesMatch: sameFileManifest(sourceDetails.files, originalReport.source?.files) },
    dependencies: null,
    corpus: { exactGames: false, gameCount: 0, filesMatch: false, mismatches: [] },
    originalDownload: null,
    blockers: [],
  }
  if (!verification.source.commitMatch || !verification.source.filesMatch) verification.blockers.push({ code: 'ARC_EXISTING_SOURCE_MISMATCH', message: 'source pin or recorded source file hashes differ' })
  const python = originalReport.dependencies?.venv ? join(originalReport.dependencies.venv, 'bin/python') : join(existing, 'venv/bin/python')
  const versionCode = [
    'import importlib.metadata as m, json, platform',
    'print(json.dumps({"python": platform.python_version(), "arc_agi": m.version("arc-agi"), "arcengine": m.version("arcengine")}, separators=(",", ":")))',
  ].join('; ')
  let versions
  try {
    versions = JSON.parse((await command(python, ['-c', versionCode], { cwd: existing, env: cleanEnv(existing), maxBuffer: 1_000_000 })).stdout.trim())
  } catch (error) {
    verification.blockers.push({ code: 'ARC_EXISTING_DEPENDENCY', message: redact(error.message) })
  }
  const expectedVersions = { python: originalReport.dependencies?.python, arcAgi: originalReport.dependencies?.arcAgi, arcengine: originalReport.dependencies?.arcengine }
  verification.dependencies = { python, expected: expectedVersions, actual: versions ?? null, versionsMatch: Boolean(versions && versions.python === expectedVersions.python && versions.arc_agi === expectedVersions.arcAgi && versions.arcengine === expectedVersions.arcengine) }
  if (!verification.dependencies.versionsMatch) verification.blockers.push({ code: 'ARC_EXISTING_DEPENDENCY_MISMATCH', message: 'existing venv versions differ from the recorded fixed dependencies' })
  const corpus = originalReport.download?.corpus
  const recordedGames = originalReport.download?.games
  if (typeof corpus !== 'string' || !Array.isArray(recordedGames)) fail('ARC_EXISTING_CORPUS', 'existing report lacks corpus path or game records')
  const expectedGames = sourceDetails.results.games
  verification.corpus.gameCount = recordedGames.length
  verification.corpus.exactGames = recordedGames.length === 25 && sameFileManifest(recordedGames.flatMap(game => game.files ?? []), recordedGames.flatMap(game => game.files ?? []))
  const recordedById = new Map(recordedGames.map(game => [game.requestedGameId, game]))
  for (const expected of expectedGames) {
    const recorded = recordedById.get(expected.requestedGameId)
    const inspected = await inspectDownloadedGame(corpus, expected)
    if (!recorded || recorded.status !== 'available' || !inspected.exact || !sameFileManifest(recorded.files, inspected.files)) {
      verification.corpus.mismatches.push({ gameId: expected.requestedGameId, recorded: recorded ? { status: recorded.status, files: recorded.files } : null, current: { exact: inspected.exact, files: inspected.files } })
    }
  }
  verification.corpus.exactGames = verification.corpus.exactGames && recordedById.size === 25 && expectedGames.every(game => recordedById.has(game.requestedGameId))
  verification.corpus.filesMatch = verification.corpus.mismatches.length === 0 && verification.corpus.exactGames
  if (!verification.corpus.filesMatch) verification.blockers.push({ code: 'ARC_EXISTING_CORPUS_MISMATCH', message: `${verification.corpus.mismatches.length} corpus records differ from the exact 25-game manifest` })
  const rawResultPath = originalReport.download?.rawResultPath
  if (typeof rawResultPath !== 'string' || !(await pathExists(rawResultPath))) fail('ARC_EXISTING_DOWNLOAD_RECORD', 'original download-result.json is missing')
  const rawResult = JSON.parse(await readFile(rawResultPath, 'utf8'))
  verification.originalDownload = { path: rawResultPath, sha256: (await sha256File(rawResultPath)).sha256, toolkit: rawResult.toolkit, initialization: rawResult.initialization, eventCount: rawResult.events?.length ?? 0, gameCount: Object.keys(rawResult.games ?? {}).length }
  if (rawResult.toolkit?.version !== ARC_AGI_VERSION || rawResult.initialization?.ok !== true || Object.keys(rawResult.games ?? {}).length !== 25) verification.blockers.push({ code: 'ARC_EXISTING_DOWNLOAD_RECORD_INVALID', message: 'original download record does not contain the expected fixed Toolkit and 25-game result' })
  const originalFailure = originalReport.smoke?.blocker ?? originalReport.blockers?.find(blocker => blocker.stage === 'broker-smoke') ?? null
  return { originalReport, sourceDetails, dependencies: { python, versions }, download: { corpus, games: recordedGames }, verification, originalFailure }
}

async function runAdapterSpy(existing, dependencies, smokeOutput) {
  const result = JSON.parse((await command(dependencies.python, [ADAPTER_PATH, '--spy'], { cwd: smokeOutput, env: cleanEnv(existing), maxBuffer: 4 * 1024 * 1024 })).stdout.trim())
  if (result.passed !== true) fail('ARC_ADAPTER_SPY', 'step facade spy did not pass')
  return { ...result, adapterPath: ADAPTER_PATH, adapterSha256: (await sha256File(ADAPTER_PATH)).sha256 }
}

async function smokeExisting(args) {
  const verified = await verifyExisting(args.existing)
  const smokeOutput = await mkdtemp(join(args.existing, 'smoke-existing-'))
  const available = verified.download.games.find(game => game.status === 'available')
  if (!available) fail('ARC_EXISTING_NO_GAME', 'existing corpus has no available exact game for smoke')
  const compatibilityAdapter = args.compatStep
  const adapterHash = compatibilityAdapter ? (await sha256File(ADAPTER_PATH)).sha256 : null
  const options = {
    smokeOutput,
    compatibilityAdapter,
    brokerProgram: compatibilityAdapter ? ADAPTER_PATH : join(verified.sourceDetails.path, 'arc3_local_broker.py'),
    brokerArgs: compatibilityAdapter
      ? ['--source', verified.sourceDetails.path, '--corpus', verified.download.corpus, '--game', available.requestedGameId, '--socket', join(smokeOutput, 'broker.sock')]
      : undefined,
  }
  let spy = null
  let smoke
  try {
    if (compatibilityAdapter) spy = await runAdapterSpy(args.existing, verified.dependencies, smokeOutput)
    smoke = await runBrokerSmoke(args.existing, verified.sourceDetails, verified.dependencies, verified.download, options)
  } finally {
    // runBrokerSmoke owns and stops only its own broker. The source is checked again below.
  }
  let afterSource = null
  try {
    afterSource = await ensureSource(verified.sourceDetails.path, { allowClone: false })
  } catch (error) {
    verified.verification.blockers.push({ code: 'ARC_SOURCE_DIRTY_AFTER_SMOKE', message: redact(error.message) })
  }
  const report = {
    formatVersion: FORMAT_VERSION,
    mode: 'smoke-existing',
    generatedAt: new Date().toISOString(),
    existingOutput: args.existing,
    compatibilityAdapter: compatibilityAdapter ? { path: ADAPTER_PATH, sha256: adapterHash, exactAuthorReproduction: false, sourceUnmodified: true, preservedBrokerLogic: ['500 action cap', '20-action batch limit', 'GAME_OVER consumes one RESET', 'WIN/level-change batch termination'] } : null,
    verification: verified.verification,
    originalFailure: verified.originalFailure,
    adapterSpy: spy,
    smoke,
    sourceAfterSmoke: afterSource ? { commit: afterSource.commit, clean: afterSource.clean, files: afterSource.files } : null,
    sideEffects: { network: false, install: false, modelCalls: 0, existingReportOverwritten: false },
    blockers: [...verified.verification.blockers, ...(smoke?.blocker && !compatibilityAdapter ? [{ stage: 'original-broker-smoke', detail: smoke.blocker }] : []), ...(smoke?.blocker && compatibilityAdapter ? [{ stage: 'compatible-adapter-smoke', detail: smoke.blocker }] : [])],
  }
  report.reportPath = join(smokeOutput, 'smoke-report.json')
  await writeJson(report.reportPath, report)
  console.log(JSON.stringify({ report: report.reportPath, smokeOutput, compatibilityAdapter, modelCalls: 0, actionsTaken: smoke.finalActionsTaken ?? null, blockers: report.blockers.length }, null, 2))
  if (report.blockers.length > 0) process.exitCode = 2
}

async function prepare(args) {
  const output = args.output
  if (await pathExists(output)) fail('ARC_OUTPUT_EXISTS', `refusing to reuse or overwrite existing output: ${output}`)
  await mkdir(output, { recursive: true, mode: 0o700 })
  const sourceExisted = await pathExists(args.source)
  const report = {
    formatVersion: FORMAT_VERSION,
    mode: 'prepare',
    startedAt: new Date().toISOString(),
    sideEffects: { network: false, install: false, modelCalls: 0 },
    source: null,
    dependencies: null,
    download: null,
    smoke: null,
    blockers: [],
    cleanup: { ownBrokerOnly: true },
  }
  let sourceDetails
  try {
    sourceDetails = await ensureSource(args.source, { allowClone: true })
    report.source = { repository: sourceDetails.repository, commit: sourceDetails.commit, commitUrl: sourceDetails.commitUrl, checkout: sourceDetails.path, commitDate: sourceDetails.commitDate, clean: sourceDetails.clean, files: sourceDetails.files, requiredFiles: sourceDetails.requiredFiles, results: sourceDetails.results }
    report.sideEffects.network = !sourceExisted
  } catch (error) {
    report.blockers.push(sourceError(error))
  }
  let dependencies
  if (sourceDetails) {
    try {
      dependencies = await setupDependencies(output)
      report.dependencies = { python: dependencies.versions.python, arcAgi: dependencies.versions.arc_agi, arcengine: dependencies.versions.arcengine, uv: dependencies.uv, venv: dependencies.venv, freeze: dependencies.freezePath }
      report.sideEffects.install = true
    } catch (error) {
      report.blockers.push({ stage: 'dependency-install', ...sourceError(error) })
    }
  }
  let download
  if (sourceDetails && dependencies) {
    try {
      download = await downloadCorpus(output, sourceDetails, dependencies)
      report.download = download
      report.sideEffects.network = true
    } catch (error) {
      report.blockers.push({ stage: 'corpus-download', ...sourceError(error) })
    }
  }
  if (sourceDetails && dependencies && download) {
    try {
      report.smoke = await runBrokerSmoke(output, sourceDetails, dependencies, download)
      if (report.smoke.blocker) report.blockers.push({ stage: 'broker-smoke', detail: report.smoke.blocker })
    } catch (error) {
      report.blockers.push({ stage: 'broker-smoke', ...sourceError(error) })
    }
  }
  report.finishedAt = new Date().toISOString()
  report.reportPath = join(output, 'report.json')
  await writeJson(report.reportPath, report)
  console.log(JSON.stringify({ report: report.reportPath, blockers: report.blockers.length, availableGames: report.download?.games?.filter(game => game.status === 'available').length ?? 0, modelCalls: report.sideEffects.modelCalls }, null, 2))
  if (report.blockers.length > 0) process.exitCode = 2
}

async function preflight(args) {
  const blockers = []
  let details = null
  try {
    details = await ensureSource(args.source, { allowClone: false })
  } catch (error) {
    blockers.push(sourceError(error))
  }
  console.log(JSON.stringify(preflightReport(args.source, details, blockers), null, 2))
  if (blockers.length > 0) process.exitCode = 2
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.mode === 'prepare') await prepare(args)
  else if (args.mode === 'smoke-existing') await smokeExisting(args)
  else await preflight(args)
}

main().catch(error => {
  console.error(redact(error.stack ?? error.message))
  process.exitCode = 1
})

