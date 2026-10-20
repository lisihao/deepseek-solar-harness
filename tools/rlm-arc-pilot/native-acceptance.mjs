#!/opt/homebrew/opt/node@22/bin/node

/*
 * Zero-model R/S smoke. This is deliberately a local parent: it compiles the
 * current source, starts the real fixed Prime capsule and a real pinned ar25
 * broker, but supplies three deterministic DSH stream responses through the
 * worker IPC. It has no credential path and never imports a subscription
 * provider.
 */

import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { copyFile, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAttachmentRelay } from './attachment-relay.mjs'
import { createGameBroker } from './broker.mjs'
import { policy } from './sandbox.mjs'

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const WORKER_SOURCE = join(ROOT, 'tools', 'rlm-arc-pilot', 'native-worker.mjs')
const PACKAGE = join(ROOT, 'incubator', 'rlm')
const NODE = '/opt/homebrew/opt/node@22/bin/node'
const GAME_ID = 'ar25-0c556536'
// The fixed local-store acceptance uses a clean RGB8 PNG.  The official
// store keeps this representation byte-for-byte; a previous grayscale+alpha
// fixture was legitimately normalized to WebP and cannot prove byte relay.
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC', 'base64')
const TINY_PNG_SHA256 = createHash('sha256').update(TINY_PNG).digest('hex')
const MODEL_INFO = Object.freeze({
  provider: 'openai-codex',
  id: 'gpt-6.1-sol',
  name: 'ARC native zero-model fixture',
  inputModalities: ['text', 'image'],
  context: { contextWindow: 200_000 },
  defaultMaxTokens: 16_384,
  reasoning: { defaultEffort: 'high', efforts: ['high'] },
})

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function usage() {
  return [
    'Usage:',
    '  native-acceptance.mjs --shared <absolute-shared> --author <absolute-author-root> --author-preparation <absolute-preparation-root>',
    '',
    'This runs only deterministic local parent IPC model chunks. It does not use a subscription provider or credentials.',
  ].join('\n')
}

async function requiredDirectory(value, flag) {
  assert.equal(typeof value, 'string', `${flag} requires a path`)
  assert.ok(isAbsolute(value), `${flag} must be an absolute path`)
  const path = resolve(value)
  const info = await stat(path)
  assert.equal(info.isDirectory(), true, `${flag} must name a directory`)
  return path
}

async function parseInputs(argv) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(`${usage()}\n`)
    process.exit(0)
  }
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    assert.ok(['--shared', '--author', '--author-preparation'].includes(flag), `unknown argument ${String(flag)}\n${usage()}`)
    assert.ok(value !== undefined && !value.startsWith('--'), `${flag} requires a path\n${usage()}`)
    assert.equal(values.has(flag), false, `${flag} was supplied more than once`)
    values.set(flag, value)
  }
  assert.equal(values.size, 3, `--shared, --author, and --author-preparation are required\n${usage()}`)
  return Object.freeze({
    shared: await requiredDirectory(values.get('--shared'), '--shared'),
    author: await requiredDirectory(values.get('--author'), '--author'),
    preparation: await requiredDirectory(values.get('--author-preparation'), '--author-preparation'),
  })
}

async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function fixedSourceHashes(inputs) {
  const entries = [
    ['worker', WORKER_SOURCE],
    ['authorPrompt', join(inputs.author, 'game-prompt.txt')],
    ['authorAgents', join(inputs.author, 'AGENTS.md')],
    ['authorBrokerClient', join(inputs.author, 'broker_client.py')],
    ['compiledHost', join(inputs.shared, 'compiled', 'host.mjs')],
    ['compiledRuntime', join(inputs.shared, 'compiled', 'runtime.mjs')],
  ]
  return Object.fromEntries(await Promise.all(entries.map(async ([name, path]) => [name, { path, sha256: await sha256File(path) }])))
}

function collectImageAttachments(value, output = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectImageAttachments(entry, output)
    return output
  }
  if (!value || typeof value !== 'object') return output
  if (value.type === 'image' && value.attachment && typeof value.attachment === 'object') output.push(value.attachment)
  for (const entry of Object.values(value)) collectImageAttachments(entry, output)
  return output
}

function imagePlaceholderSummary(value) {
  return collectImageAttachments(value)
    .filter(attachment => attachment.kind === 'ipc-inline-image-v1')
    .map(attachment => ({
      kind: attachment.kind,
      mediaType: attachment.mediaType,
      bytes: attachment.bytes,
      sha256: attachment.sha256,
    }))
}

async function restoredImageSummary(value, relay) {
  const refs = collectImageAttachments(value).filter(attachment => typeof attachment.attachmentId === 'string')
  return Promise.all(refs.map(async ref => {
    const stored = await relay.store.readImage(ref)
    const data = Buffer.from(stored.data)
    return {
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      bytes: data.byteLength,
      sha256: createHash('sha256').update(data).digest('hex'),
      matchesFixture: data.equals(TINY_PNG) && ref.mediaType === 'image/png',
    }
  }))
}

function compactModelOptions(options) {
  return {
    messageCount: Array.isArray(options.messages) ? options.messages.length : null,
    provider: options.provider,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    maxTokens: options.maxTokens,
    imagePlaceholders: imagePlaceholderSummary(options),
  }
}

function textChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 8, outputTokens: 2 } },
    { type: 'finish', reason: { kind: 'stop' }, replayState: { fixture: { text } } },
  ]
}

function toolChunks(id, code) {
  const argumentsText = JSON.stringify({ code })
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name: 'python_repl', argumentsDelta: argumentsText },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'python_repl', arguments: argumentsText } },
    { type: 'usage', usage: { inputTokens: 8, outputTokens: 2 } },
    { type: 'finish', reason: { kind: 'tool-calls' }, replayState: { fixture: { tool: id } } },
  ]
}

async function listen(server, options) {
  server.listen(options)
  await once(server, 'listening')
}

async function close(server) {
  if (!server?.listening) return
  await new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()))
}

async function reserveBridgePort() {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const ipv4 = createServer(socket => socket.destroy())
    await listen(ipv4, { host: '127.0.0.1', port: 0 })
    const address = ipv4.address()
    assert(address && typeof address !== 'string')
    const ipv6 = createServer(socket => socket.destroy())
    try {
      await listen(ipv6, { host: '::1', port: address.port, ipv6Only: true })
      await close(ipv4)
      return { port: address.port, ipv6 }
    } catch {
      await Promise.allSettled([close(ipv4), close(ipv6)])
    }
  }
  throw new Error('ARC_SMOKE_PORT: unable to reserve a matching IPv4/IPv6 bridge port')
}

async function writeWorkspace(workspace, author) {
  await Promise.all([
    copyFile(join(author, 'AGENTS.md'), join(workspace, 'AGENTS.md')),
    copyFile(join(author, 'broker_client.py'), join(workspace, 'fixed_broker_client.py')),
    copyFile(join(author, 'broker_client.py'), join(workspace, 'broker_client.py')),
  ])
}

function smokeTask({ author, brokerSocket, brokerState }) {
  // The source prompt remains verbatim. The separate bootstrap is the same
  // explicit environment handoff used by the controller, rather than a worker
  // rewrite of the author instructions.
  return readFile(join(author, 'game-prompt.txt'), 'utf8').then(authorPrompt => `${authorPrompt}\n\nExplicit controller bootstrap for this isolated run:\nimport os\nos.environ["ARC3_GAME_BROKER_SOCKET"] = ${JSON.stringify(brokerSocket)}\nos.environ["ARC3_STATE"] = ${JSON.stringify(brokerState)}\n`)
}

function pythonCell({ workspace, brokerSocket, brokerState, corpusProgram }) {
  // A valid 1x1 PNG exercises Prime's Python display path. If Prime emits an
  // image attachment, the trusted parent relay restores it before the fixture
  // streams the next response.
  return [
    'import base64, errno, os, socket, sys',
    'from pathlib import Path',
    `os.environ["ARC3_GAME_BROKER_SOCKET"] = ${JSON.stringify(brokerSocket)}`,
    `os.environ["ARC3_STATE"] = ${JSON.stringify(brokerState)}`,
    `sys.path.insert(0, ${JSON.stringify(workspace)})`,
    'from fixed_broker_client import observe, act',
    'first = observe()',
    'second = act([{"name":"ACTION1","data":{}}])',
    'third = act([{"name":"ACTION2","data":{}}])',
    'import subprocess',
    'gate_probe = subprocess.run([sys.executable, "fixed_broker_client.py", "terminal-gate"], capture_output=True, text=True)',
    'Path("gate.done").write_text("ok")',
    'print("ARC_SMOKE", first.get("terminal"), second.get("actions_taken"), third.get("actions_taken"))',
    'print("ARC_TERMINAL_GATE", gate_probe.returncode, gate_probe.stderr.strip()[:120])',
    'def _denied_read(path):',
    '    try:',
    '        Path(path).read_bytes()',
    '    except OSError as exc:',
    '        return exc.errno',
    '    return None',
    'def _denied_tcp():',
    '    client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)',
    '    client.settimeout(2)',
    '    try:',
    '        client.connect(("1.1.1.1", 443))',
    '    except OSError as exc:',
    '        return exc.errno',
    '    finally:',
    '        client.close()',
    '    return None',
    `denial_errnos = [_denied_read(${JSON.stringify(corpusProgram)}), _denied_read("/Users/sihaoli/.dsh/.credentials.yaml"), _denied_tcp()]`,
    'if any(code not in (errno.EPERM, errno.EACCES) for code in denial_errnos):',
    '    raise RuntimeError("ARC_PYTHON_DENIALS_FAILED:" + repr(denial_errnos))',
    'print("ARC_PYTHON_DENIALS", len(denial_errnos), ",".join(str(code) for code in denial_errnos))',
    'try:',
    '    image_path = Path("arc-smoke.png")',
    `    image_path.write_bytes(base64.b64decode(${JSON.stringify(TINY_PNG.toString('base64'))}))`,
    '    image_result = await attach_image(str(image_path.resolve()))',
    '    print("ARC_IMAGE_ATTACH", image_result)',
    'except Exception as exc:',
    '    print("ARC_IMAGE_DISPLAY_ERROR", type(exc).__name__, str(exc)[:160])',
  ].join('\n')
}

async function waitWorker(child, timeoutMs) {
  return new Promise((resolveResult, rejectResult) => {
    let result
    let stderr = ''
    let stdout = ''
    const timer = setTimeout(() => {
      child.send?.({ type: 'stop', reason: 'ARC_SMOKE_TIMEOUT' })
      setTimeout(() => child.kill('SIGTERM'), 20_000).unref()
    }, timeoutMs)
    timer.unref()
    child.stdout?.on('data', value => { stdout = (stdout + value.toString('utf8')).slice(-32_000) })
    child.stderr?.on('data', value => { stderr = (stderr + value.toString('utf8')).slice(-32_000) })
    child.on('message', value => { if (value?.type === 'result') result = value })
    child.once('error', rejectResult)
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolveResult({ result, exit: { code, signal }, stdout, stderr })
    })
  })
}

async function runArm(root, arm, inputs, sourceHashes) {
  const armRoot = join(root, arm)
  const run = armRoot
  const shared = inputs.shared
  const compiled = join(shared, 'compiled')
  const runtimes = join(shared, 'runtimes')
  const privateBroker = join(root, `${arm}-private-broker`)
  const workspace = join(run, 'workspace')
  const brokerState = join(run, 'data', 'broker-state')
  await Promise.all([
    mkdir(workspace, { recursive: true, mode: 0o700 }),
    mkdir(join(run, 'home'), { recursive: true, mode: 0o700 }),
    mkdir(join(run, 'tmp'), { recursive: true, mode: 0o700 }),
    mkdir(brokerState, { recursive: true, mode: 0o700 }),
    mkdir(privateBroker, { recursive: true, mode: 0o700 }),
  ])
  const data = join(run, 'data')
  await Promise.all([
    writeWorkspace(workspace, inputs.author),
    copyFile(WORKER_SOURCE, join(run, 'native-worker.mjs')),
    symlink(runtimes, join(data, 'runtimes'), 'dir'),
  ])
  const bridge = await reserveBridgePort()
  const guardSocket = join(run, 'guard.sock')
  const broker = await createGameBroker({
    sourceRoot: inputs.author,
    corpus: join(inputs.preparation, 'corpus'),
    python: join(inputs.preparation, 'venv', 'bin', 'python'),
    adapterPath: join(ROOT, 'tools', 'fixtures', 'rlm-arc-prepare', 'sdk-step-adapter.py'),
    gameId: GAME_ID,
    directory: privateBroker,
    proxySocket: guardSocket,
  })
  const relay = await createAttachmentRelay({ sourceRoot: ROOT, dataRoot: join(armRoot, 'parent-attachment-data') })
  const modelMessages = []
  const sent = []
  let child
  try {
    const task = await smokeTask({ author: inputs.author, brokerSocket: guardSocket, brokerState })
    const profile = policy({
      directory: run,
      shared,
      readRoots: [PACKAGE, runtimes, join(ROOT, 'node_modules')],
      bridgePort: bridge.port,
      brokerPrivateRoot: privateBroker,
      protectedRoots: [inputs.author, join(inputs.preparation, 'corpus'), privateBroker],
    })
    const profilePath = join(run, 'sandbox.sb')
    await writeFile(profilePath, profile, { mode: 0o600 })
    child = fork(join(run, 'native-worker.mjs'), [], {
      cwd: workspace,
      execPath: '/usr/bin/sandbox-exec',
      execArgv: ['-f', profilePath, NODE],
      env: {
        PATH: '/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: join(run, 'home'),
        TMPDIR: join(run, 'tmp'),
        LANG: 'C.UTF-8',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    let tail = Promise.resolve()
    child.on('message', message => {
      if (message?.type !== 'model') return
      tail = tail.then(async () => {
        const options = clone(message.options)
        assert.equal(options.provider, 'openai-codex')
        assert.equal(options.model, 'gpt-6.1-sol')
        assert.equal(options.reasoningEffort, 'high')
        assert.equal(options.maxTokens, 16_384)
        const ordinal = modelMessages.length + 1
        const raw = compactModelOptions(options)
        const normalized = await relay.restoreOptions(options)
        const restoredImages = await restoredImageSummary(normalized, relay)
        modelMessages.push({ ordinal, raw, restoredImages })
        const history = JSON.stringify(normalized)
        let chunks
        if (ordinal === 1) chunks = textChunks('EARLY_STOP')
        else if (ordinal === 2) {
          assert.match(history, /EARLY_STOP/)
          chunks = toolChunks('arc-smoke-python', pythonCell({
            workspace,
            brokerSocket: guardSocket,
            brokerState,
            corpusProgram: join(inputs.preparation, 'corpus', 'ar25', '0c556536', 'ar25.py'),
          }))
        } else if (ordinal === 3) {
          assert.match(history, /ARC_SMOKE/)
          assert.match(history, /ARC_TERMINAL_GATE/)
          assert.match(history, /ARC_PYTHON_DENIALS 3/)
          chunks = textChunks('DONE')
        } else throw new Error(`unexpected local fixture model request ${String(ordinal)}`)
        for (const chunk of chunks) child.send({ type: 'chunk', id: message.id, chunk })
        sent.push({ id: message.id, ordinal, chunks: chunks.length })
        child.send({ type: 'end', id: message.id })
      }).catch(failure => child.send({ type: 'error', id: message.id, error: failure.message }))
    })
    child.send({
      type: 'start',
      arm,
      directory: run,
      shared,
      compiled,
      packageRoot: PACKAGE,
      task,
      route: { provider: 'openai-codex', model: 'gpt-6.1-sol', reasoningEffort: 'high', maxOutputTokens: 16_384 },
      modelInfo: MODEL_INFO,
      requestLimit: 32,
      wallTimeMs: 3_600_000,
      autonomous: { maxTurns: 32, maxTokens: 4_000_000, gate: 'test -f gate.done' },
      brokerSocket: guardSocket,
      brokerState,
      bridgePort: bridge.port,
      dependencyReadRoots: [PACKAGE, join(ROOT, 'node_modules')],
    })
    const worker = await waitWorker(child, 180_000)
    await tail
    const observed = await broker.inspect()
    const brokerReceipt = await broker.stop()
    const result = worker.result
    const receiptHashes = {
      workerConfig: {
        path: join(data, 'native-worker-config.original.json'),
        sha256: await sha256File(join(data, 'native-worker-config.original.json')),
      },
      workerJournal: {
        path: join(data, 'native-worker-events.jsonl'),
        sha256: await sha256File(join(data, 'native-worker-events.jsonl')),
      },
    }
    const thirdRequest = modelMessages.find(message => message.ordinal === 3)
    const imageProof = {
      requestOrdinal: 3,
      rawPlaceholder: thirdRequest?.raw.imagePlaceholders ?? [],
      restoredImages: thirdRequest?.restoredImages ?? [],
    }
    const report = {
      formatVersion: 1,
      kind: 'zero-model-native-rs-smoke',
      arm,
      gameId: GAME_ID,
      fixtureProvider: 'parent IPC deterministic chunks only; no subscription provider or credentials',
      inputs: {
        shared,
        author: inputs.author,
        authorPreparation: inputs.preparation,
        packageRoot: PACKAGE,
      },
      sourceHashes,
      receiptHashes,
      worker,
      result,
      modelMessages,
      sent,
      observed,
      brokerReceipt,
      imageProof,
      realModelRequests: 0,
    }
    const reportPath = join(armRoot, 'report.json')
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    assert(result, 'worker sent no result receipt')
    assert.equal(result.state, 'completed', JSON.stringify(result.fault ?? result))
    assert.equal(result.physicalCleanup, true, JSON.stringify(result.cleanup))
    assert.equal(worker.exit.code, 0, worker.stderr)
    assert.equal(result.requests, 3)
    assert.equal(modelMessages.length, 3)
    assert.equal(observed.actions_taken, 2)
    assert.equal(observed.terminal, 'ACTIVE')
    assert.ok(imageProof.rawPlaceholder.length > 0, 'third model request did not carry an IPC image placeholder')
    assert.ok(imageProof.restoredImages.length > 0, 'the same third model request did not restore an official image reference')
    assert.ok(imageProof.restoredImages.every(image => image.matchesFixture && image.bytes === TINY_PNG.byteLength && image.sha256 === TINY_PNG_SHA256), 'restored image bytes do not match the Prime/Python PNG fixture')
    return { ...report, reportPath, reportSha256: await sha256File(reportPath) }
  } finally {
    if (child?.connected) child.send({ type: 'stop', reason: 'parent cleanup' })
    await Promise.allSettled([relay.close(), broker.stop(), close(bridge.ipv6)])
  }
}

async function main() {
  assert.equal(process.versions.node.split('.')[0], '22', `expected Node 22, got ${process.version}`)
  const inputs = await parseInputs(process.argv.slice(2))
  const sourceHashes = await fixedSourceHashes(inputs)
  const root = await mkdtemp('/private/tmp/ank-')
  const reports = []
  for (const arm of ['R', 'S']) reports.push(await runArm(root, arm, inputs, sourceHashes))
  const summary = {
    formatVersion: 1,
    kind: 'zero-model-native-rs-smoke',
    root,
    inputs,
    sourceHashes,
    realModelRequests: 0,
    reports: reports.map(report => ({
      arm: report.arm,
      reportPath: report.reportPath,
      reportSha256: report.reportSha256,
      receiptHashes: report.receiptHashes,
      workerExit: report.worker.exit,
      state: report.result.state,
      requests: report.result.requests,
      physicalCleanup: report.result.physicalCleanup,
      observed: {
        terminal: report.observed.terminal,
        actionsTaken: report.observed.actions_taken,
      },
      imageProof: report.imageProof,
    })),
  }
  await writeFile(join(root, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write(`${JSON.stringify(summary)}\n`)
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error.message}\n`)
  process.exitCode = 1
})
