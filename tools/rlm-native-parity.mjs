import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { appendFile, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)))
const RLM_ROOT = join(ROOT, 'incubator', 'rlm')
const TEMP_ROOT = '/private/tmp'
const REPORT_VERSION = 1
const REQUEST_TIMEOUT_MS = 120_000
const MAX_REQUESTS = 6
const PROVIDER = 'solar-dsh'
const MODEL = 'selected'
const NATIVE_TOKEN = 'PARITY_NATIVE_LOCAL_TOKEN'
const TOOL_CALL_ID = 'parity-python-call-42'
const TOOL_CODE = [
  'from pathlib import Path',
  "Path('gate.done').write_text('42')",
  "print('TOOL_42', Path('gate.done').read_text())",
].join('\n')
const TOOL_ARGUMENTS = JSON.stringify({ code: TOOL_CODE })
const TASK = 'PARITY_AUTONOMOUS_V1: finish only through the native autonomous gate. The fixture model controls the three deterministic local responses.'
const AUTONOMOUS = Object.freeze({
  maxTurns: 6,
  maxTokens: 80_000,
  gate: 'test -f gate.done',
})
const MODEL_ROUTE = Object.freeze({
  provider: PROVIDER,
  model: MODEL,
  reasoningEffort: 'off',
  maxTokens: 512,
})

function parseCommandLine(argv) {
  const result = { packageRoot: RLM_ROOT, recheckRoot: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--package-root') {
      const value = argv[index + 1]
      if (typeof value !== 'string' || value.length === 0) throw new Error('--package-root requires an absolute package directory')
      if (!isAbsolute(value)) throw new Error('--package-root must be an absolute package directory')
      result.packageRoot = resolve(value)
      index += 1
      continue
    }
    if (argument === '--recheck') {
      const value = argv[index + 1]
      if (typeof value !== 'string' || value.length === 0) throw new Error('--recheck requires an existing parity evidence directory')
      if (!isAbsolute(value)) throw new Error('--recheck must name an absolute parity evidence directory')
      result.recheckRoot = resolve(value)
      index += 1
      continue
    }
    throw new Error(`unknown argument ${JSON.stringify(argument)}; expected --package-root <absolute> and/or --recheck <absolute>`)
  }
  return result
}

function errorText(error) {
  return error instanceof Error ? error.stack ?? error.message : String(error)
}

function assertion(condition, message) {
  if (!condition) throw new Error(message)
}

function recordError(error) {
  return { name: error instanceof Error ? error.name : 'Error', message: errorText(error) }
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cloneEvidence(value) {
  const encoded = JSON.stringify(value, (key, candidate) => {
    if (key === 'signal') return undefined
    if (typeof candidate === 'bigint') return candidate.toString()
    return candidate
  })
  return encoded === undefined ? undefined : JSON.parse(encoded)
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function hashText(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function writePrivate(path, contents) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, contents, { encoding: 'utf8', mode: 0o600 })
}

async function writeJson(path, value) {
  await writePrivate(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function appendJsonLine(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await appendFile(path, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 })
}

async function readJsonLines(path) {
  const source = await readFile(path, 'utf8')
  return source.split('\n').filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new Error(`invalid JSONL at ${path}:${String(index + 1)}: ${errorText(error)}`)
    }
  })
}

async function readIfPresent(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

function delay(milliseconds) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds))
}

function onlyLocalEnvironment({ home, agentDir, sessionDir, socket, runtime }) {
  const result = {
    HOME: home,
    USER: 'rlm-parity',
    LOGNAME: 'rlm-parity',
    PATH: process.env.PATH ?? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    LANG: process.env.LANG ?? 'C',
    LC_ALL: process.env.LC_ALL ?? 'C',
    TMPDIR: TEMP_ROOT,
    PI_OFFLINE: '1',
    UV_OFFLINE: '1',
    PYTHONNOUSERSITE: '1',
    DO_NOT_TRACK: '1',
    PRIME_AGENT_TELEMETRY: '0',
    PRIME_AGENT_TELEMETRY_DISABLED: '1',
    PI_PACKAGE_DIR: runtime.packageDir,
    PRIME_AGENT_CODING_AGENT_DIR: agentDir,
    PRIME_AGENT_SESSION_DIR: sessionDir,
    PRIME_AGENT_DAEMON_SOCKET: socket,
    PRIME_AGENT_KERNEL_PYTHON: runtime.python,
  }
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined))
}

function replaceProcessEnvironment(values) {
  const previous = new Map()
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key])
    process.env[key] = value
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return new Promise(resolveExit => {
    const timer = setTimeout(() => resolveExit(false), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveExit(true)
    })
  })
}

async function runOwnedCommand(binary, args, { cwd, env, timeoutMs }) {
  const child = spawn(binary, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const stdout = []
  const stderr = []
  child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)))
  child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)))
  let timedOut = false
  const result = await new Promise(resolveResult => {
    let finished = false
    const finish = value => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolveResult(value)
    }
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch { /* The owned helper has already exited. */ }
    }, timeoutMs)
    timer.unref?.()
    child.once('error', error => finish({ code: null, signal: null, spawnError: errorText(error) }))
    child.once('close', (code, signal) => finish({ code, signal, spawnError: undefined }))
  })
  return {
    args,
    ...result,
    timedOut,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  }
}

function responseForOrdinal(ordinal, request) {
  if (ordinal === 1) {
    return { ordinal, kind: 'text', text: 'EARLY_STOP', finishReason: 'stop' }
  }
  if (ordinal === 2) {
    assertion(JSON.stringify(request).includes('EARLY_STOP'), 'second local response did not receive EARLY_STOP in history')
    return {
      ordinal,
      kind: 'tool-call',
      id: TOOL_CALL_ID,
      name: 'python_repl',
      arguments: TOOL_ARGUMENTS,
      finishReason: 'tool_calls',
    }
  }
  if (ordinal === 3) {
    assertion(JSON.stringify(request).includes('TOOL_42 42'), 'third local response did not receive actual Python tool result TOOL_42 42')
    return { ordinal, kind: 'text', text: 'DONE', finishReason: 'stop' }
  }
  throw new Error(`fixture received unexpected local model request ${String(ordinal)}; expected exactly three`)
}

function openAiFrame({ ordinal, delta, finishReason }) {
  return {
    id: `parity-response-${String(ordinal)}`,
    object: 'chat.completion.chunk',
    created: 0,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

function openAiFrames(reply) {
  if (reply.kind === 'text') {
    return [
      openAiFrame({ ordinal: reply.ordinal, delta: { role: 'assistant', content: reply.text }, finishReason: null }),
      openAiFrame({ ordinal: reply.ordinal, delta: {}, finishReason: reply.finishReason }),
    ]
  }
  return [
    openAiFrame({
      ordinal: reply.ordinal,
      delta: {
        role: 'assistant',
        tool_calls: [{
          index: 0,
          id: reply.id,
          type: 'function',
          function: { name: reply.name, arguments: reply.arguments },
        }],
      },
      finishReason: null,
    }),
    openAiFrame({ ordinal: reply.ordinal, delta: {}, finishReason: reply.finishReason }),
  ]
}

async function requestBody(request) {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    const value = Buffer.from(chunk)
    bytes += value.length
    if (bytes > 4 * 1024 * 1024) throw new Error('local fake provider request exceeded 4 MiB')
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function startNativeFakeProvider() {
  const requests = []
  const responses = []
  let serverClosed = false
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'only local /v1/chat/completions is available' } }))
        return
      }
      const remote = request.socket.remoteAddress
      if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
        throw new Error(`fake provider rejected non-loopback peer ${String(remote)}`)
      }
      if (request.headers.authorization !== `Bearer ${NATIVE_TOKEN}`) throw new Error('fake provider received an unexpected authorization value')
      const raw = await requestBody(request)
      const body = JSON.parse(raw)
      if (!isObject(body) || body.model !== MODEL || body.stream !== true) throw new Error('native Prime did not use the fixed local OpenAI route')
      const ordinal = requests.length + 1
      if (ordinal > MAX_REQUESTS) throw new Error(`native Prime exceeded local request cap ${String(MAX_REQUESTS)}`)
      const captured = {
        ordinal,
        headers: Object.fromEntries(Object.entries(request.headers).sort(([left], [right]) => left.localeCompare(right))),
        raw,
        body,
      }
      requests.push(captured)
      const reply = responseForOrdinal(ordinal, body)
      const frames = openAiFrames(reply)
      responses.push({ ...reply, frames })
      response.writeHead(200, {
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'content-type': 'text/event-stream; charset=utf-8',
      })
      for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`)
      response.end('data: [DONE]\n\n')
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: errorText(error), type: 'rlm_native_parity' } }))
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('local fake provider did not expose a TCP port')
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
    requests,
    responses,
    listening: () => server.listening,
    async close() {
      if (serverClosed) return
      serverClosed = true
      server.closeAllConnections?.()
      if (!server.listening) return
      await new Promise((resolveClose, rejectClose) => server.close(error => error === undefined ? resolveClose() : rejectClose(error)))
    },
  }
}

class FakeAdapter {
  constructor() {
    this.requests = []
    this.responses = []
  }

  async *stream(options) {
    options.signal?.throwIfAborted?.()
    const request = cloneEvidence(options)
    const ordinal = this.requests.length + 1
    if (request.provider !== PROVIDER || request.model !== MODEL) throw new Error('FakeAdapter received an unexpected DSH route')
    if (request.reasoningEffort !== 'off' || request.maxTokens !== 512) throw new Error('FakeAdapter received changed thinking or output controls')
    if (ordinal > MAX_REQUESTS) throw new Error(`FakeAdapter exceeded local request cap ${String(MAX_REQUESTS)}`)
    this.requests.push({ ordinal, request })
    const reply = responseForOrdinal(ordinal, request)
    if (reply.kind === 'text') {
      this.responses.push({ ...reply, stream: 'authoritative-text-block' })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply.text.slice(0, 3) }
      yield { type: 'text-delta', index: 0, text: reply.text.slice(3) }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply.text } }
      yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    // The deliberately whitespace-padded provisional delta must not become the
    // wire tool arguments. The final block below is authoritative.
    const provisionalArguments = ` \n\t${reply.arguments}  \t`
    this.responses.push({
      ...reply,
      stream: 'authoritative-tool-block',
      provisionalArguments,
      authoritativeArguments: reply.arguments,
    })
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: reply.id, name: reply.name, argumentsDelta: provisionalArguments }
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: reply.id, name: reply.name, arguments: reply.arguments },
    }
    yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

class FakeDshLlm {
  constructor(adapter) {
    this.adapter = adapter
  }

  async resolveModelInfo(provider, model) {
    if (provider !== PROVIDER || model !== MODEL) throw new Error(`unexpected model resolution ${String(provider)}/${String(model)}`)
    return {
      provider,
      id: model,
      name: 'Prime native parity local fixture',
      inputModalities: ['text'],
      context: { contextWindow: 8192 },
      defaultMaxTokens: 512,
    }
  }

  async prepareCall(config, signal) {
    const route = cloneEvidence(config)
    if (route.provider !== PROVIDER || route.model !== MODEL || route.reasoningEffort !== 'off' || route.maxTokens !== 512) {
      throw new Error('RlmHost did not prepare the fixed parity route')
    }
    return {
      config: route,
      stream: actual => this.adapter.stream({ ...actual, signal: actual.signal ?? signal }),
    }
  }
}

async function compileSources(root) {
  const outdir = join(root, 'compiled')
  await mkdir(outdir, { recursive: true, mode: 0o700 })
  // Keep third-party packages external. Some published DSH modules resolve
  // their own package.json relative to their real module path; a temporary
  // node_modules link preserves that layout without copying or modifying them.
  await symlink(join(ROOT, 'node_modules'), join(root, 'node_modules'), 'dir')
  const entries = {
    'acp-client': join(RLM_ROOT, 'src', 'acp-client.ts'),
    core: join(RLM_ROOT, 'src', 'core.ts'),
    runtime: join(RLM_ROOT, 'src', 'runtime.ts'),
  }
  for (const [name, entry] of Object.entries(entries)) {
    await build({
      absWorkingDir: RLM_ROOT,
      entryPoints: [entry],
      outfile: join(outdir, `${name}.mjs`),
      bundle: true,
      packages: 'external',
      platform: 'node',
      target: 'node22',
      format: 'esm',
      sourcemap: false,
      logLevel: 'silent',
    })
  }
  const [acp, core, runtime] = await Promise.all([
    import(pathToFileURL(join(outdir, 'acp-client.mjs')).href),
    import(pathToFileURL(join(outdir, 'core.mjs')).href),
    import(pathToFileURL(join(outdir, 'runtime.mjs')).href),
  ])
  return { AcpClient: acp.AcpClient, RlmHost: core.RlmHost, loadRuntime: runtime.loadRuntime }
}

async function writePrimeSettings({ agentDir, baseUrl }) {
  const models = {
    providers: {
      [PROVIDER]: {
        baseUrl,
        apiKey: NATIVE_TOKEN,
        api: 'openai-completions',
        authHeader: true,
        models: [{
          id: MODEL,
          name: 'Prime native parity local fixture',
          contextWindow: 8192,
          maxTokens: 512,
          reasoning: false,
          input: ['text'],
        }],
      },
    },
  }
  await Promise.all([
    writeJson(join(agentDir, 'models.json'), models),
    writeJson(join(agentDir, 'settings.json'), { factory: { enabled: false }, harnessRefinements: true }),
  ])
}

function directLaunchArguments(paths) {
  return [
    '--mode', 'acp',
    '--offline',
    '--provider', PROVIDER,
    '--model', MODEL,
    '--cwd', paths.workspace,
    '--daemon-socket', paths.socket,
    '--thinking', 'off',
    '--autonomous',
    '--autonomous-max-turns', String(AUTONOMOUS.maxTurns),
    '--autonomous-max-tokens', String(AUTONOMOUS.maxTokens),
    '--autonomous-timeout-ms', String(REQUEST_TIMEOUT_MS),
    '--autonomous-gate', AUTONOMOUS.gate,
  ]
}

function extractToolResults(requests) {
  const output = []
  for (const request of requests) {
    const body = request.body ?? request
    const messages = Array.isArray(body?.messages) ? body.messages : []
    for (const [index, message] of messages.entries()) {
      if (message?.role === 'tool') output.push({ request: request.ordinal, message: index, toolCallId: message.tool_call_id, content: message.content })
    }
  }
  return output
}

function extractInputText(requests) {
  const output = []
  for (const request of requests) {
    const body = request.body ?? request
    const messages = Array.isArray(body?.messages) ? body.messages : []
    for (const [index, message] of messages.entries()) {
      const content = message?.content
      if (typeof content === 'string') output.push({ request: request.ordinal, message: index, role: message.role, text: content })
      else if (Array.isArray(content)) {
        for (const [part, value] of content.entries()) {
          if (value?.type === 'text' && typeof value.text === 'string') output.push({ request: request.ordinal, message: index, part, role: message.role, text: value.text })
        }
      }
    }
  }
  return output
}

function extractToolDefinitions(requests) {
  return requests.map(request => ({ ordinal: request.ordinal, tools: (request.body ?? request).tools ?? null }))
}

function extractToolHistory(requests) {
  const output = []
  for (const request of requests) {
    const body = request.body ?? request
    const messages = Array.isArray(body?.messages) ? body.messages : []
    for (const [index, message] of messages.entries()) {
      if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) output.push({ request: request.ordinal, message: index, role: 'assistant', toolCalls: message.tool_calls })
      if (message?.role === 'tool') output.push({ request: request.ordinal, message: index, role: 'tool', toolCallId: message.tool_call_id, content: message.content })
    }
  }
  return output
}

function extractThinkingFields(value, path = '$', output = []) {
  if (Array.isArray(value)) {
    value.forEach((child, index) => extractThinkingFields(child, `${path}[${String(index)}]`, output))
  } else if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`
      if (key === 'reasoning' || key === 'reasoning_content' || key === 'reasoning_text' || key === 'reasoning_details' || key === 'reasoning_effort') output.push({ path: childPath, value: child })
      extractThinkingFields(child, childPath, output)
    }
  }
  return output
}

function extractParameters(requests) {
  return requests.map(request => {
    const body = cloneEvidence(request.body ?? request)
    delete body.messages
    delete body.tools
    return { ordinal: request.ordinal, parameters: body }
  })
}

function diffValues(left, right, path = '$', output = [], limit = 80) {
  if (output.length >= limit) return output
  if (Object.is(left, right)) return output
  const leftArray = Array.isArray(left)
  const rightArray = Array.isArray(right)
  if (leftArray || rightArray) {
    if (!leftArray || !rightArray) {
      output.push({ path, native: left, plugin: right })
      return output
    }
    if (left.length !== right.length) output.push({ path: `${path}.length`, native: left.length, plugin: right.length })
    for (let index = 0; index < Math.max(left.length, right.length) && output.length < limit; index += 1) diffValues(left[index], right[index], `${path}[${String(index)}]`, output, limit)
    return output
  }
  if (isObject(left) && isObject(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)])
    for (const key of [...keys].sort()) {
      if (output.length >= limit) break
      if (!(key in left) || !(key in right)) output.push({ path: `${path}.${key}`, native: left[key], plugin: right[key] })
      else diffValues(left[key], right[key], `${path}.${key}`, output, limit)
    }
    return output
  }
  output.push({ path, native: left, plugin: right })
  return output
}

function normalizer(native, plugin) {
  const replacements = [
    { label: 'native isolated workspace', source: native.paths.workspace, value: '<WORKSPACE>' },
    { label: 'plugin isolated workspace', source: plugin.paths.workspace, value: '<WORKSPACE>' },
    { label: 'native isolated agent directory', source: native.paths.agentDir, value: '<AGENT_DIR>' },
    { label: 'plugin isolated agent directory', source: plugin.paths.agentDir, value: '<AGENT_DIR>' },
    { label: 'native isolated HOME', source: native.paths.home, value: '<HOME>' },
    { label: 'plugin isolated HOME', source: plugin.paths.home, value: '<HOME>' },
    { label: 'native daemon socket', source: native.paths.socket, value: '<DAEMON_SOCKET>' },
    { label: 'plugin daemon socket', source: plugin.paths.socket, value: '<DAEMON_SOCKET>' },
    { label: 'native ACP session id', source: native.sessionId, value: '<ACP_SESSION_ID>' },
    { label: 'plugin ACP session id', source: plugin.sessionId, value: '<ACP_SESSION_ID>' },
    { label: 'plugin run id', source: plugin.runId, value: '<RUN_ID>' },
  ].filter(item => typeof item.source === 'string' && item.source.length > 0).sort((left, right) => right.source.length - left.source.length)
  const timeFields = new Set(['time', 'timestamp', 'created', 'createdAt', 'updatedAt', 'created_at', 'updated_at'])
  const normalizeString = value => {
    let result = value
    for (const replacement of replacements) result = result.split(replacement.source).join(replacement.value)
    return result
      // Prime itself generates this persistent session-log UUID. Restrict the
      // allowance to the labeled system-prompt line; arbitrary UUID values are
      // deliberately left comparable.
      .replace(/(Conversation log: [^\n]*\/sessions\/)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.jsonl)/gi, '$1<PRIME_SESSION_LOG_ID>$2')
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<ISO_8601_TIME>')
  }
  const normalize = (value, key) => {
    if (typeof value === 'string') return timeFields.has(key) ? '<TIME_FIELD>' : normalizeString(value)
    if (Array.isArray(value)) return value.map(child => normalize(child, undefined))
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, normalize(child, childKey)]))
    return value
  }
  return {
    normalize,
    declared: [
      ...replacements.map(item => item.label),
      'Prime-generated Conversation log session UUID only',
      'ISO-8601 timestamp substrings',
      'named timestamp fields',
    ],
  }
}

function compareCategory(name, native, plugin, normalize) {
  const normalizedNative = normalize(native)
  const normalizedPlugin = normalize(plugin)
  const nativeText = stableJson(normalizedNative)
  const pluginText = stableJson(normalizedPlugin)
  const passed = nativeText === pluginText
  return {
    name,
    passed,
    nativeSha256: hashText(nativeText),
    pluginSha256: hashText(pluginText),
    differences: passed ? [] : diffValues(normalizedNative, normalizedPlugin),
  }
}

function buildComparison(native, plugin) {
  const normalized = normalizer(native, plugin)
  const nativeRaw = native.requests.map(request => ({ ordinal: request.ordinal, body: request.body }))
  const pluginRaw = plugin.rawPrimeRequests
  const nativeToolResults = extractToolResults(nativeRaw)
  const pluginToolResults = extractToolResults(pluginRaw)
  const categories = [
    compareCategory('raw-openai-requests', nativeRaw, pluginRaw, normalized.normalize),
    compareCategory('input-text', extractInputText(nativeRaw), extractInputText(pluginRaw), normalized.normalize),
    compareCategory('tool-definitions', extractToolDefinitions(nativeRaw), extractToolDefinitions(pluginRaw), normalized.normalize),
    compareCategory('tool-history-and-results', extractToolHistory(nativeRaw), extractToolHistory(pluginRaw), normalized.normalize),
    compareCategory('thinking-fields', extractThinkingFields(nativeRaw), extractThinkingFields(pluginRaw), normalized.normalize),
    compareCategory('openai-request-parameters', extractParameters(nativeRaw), extractParameters(pluginRaw), normalized.normalize),
    compareCategory('native-launch-argv', native.launchArgs, plugin.launchArgs, normalized.normalize),
    compareCategory('adapter-received-dsh-request-vs-journal', plugin.requests, plugin.journalDshRequests, normalized.normalize),
    compareCategory('actual-python-tool-results', nativeToolResults, pluginToolResults, normalized.normalize),
  ]
  return {
    normalization: normalized.declared,
    categories,
    passed: categories.every(category => category.passed),
  }
}

async function sourceFingerprintForCapture(root) {
  const sourcePaths = [
    join(RLM_ROOT, 'src', 'core.ts'),
    join(RLM_ROOT, 'src', 'prime-evidence.ts'),
    join(RLM_ROOT, 'src', 'execution.ts'),
    join(RLM_ROOT, 'src', 'model-wire.ts'),
    join(RLM_ROOT, 'src', 'runtime.ts'),
    join(RLM_ROOT, 'src', 'acp-client.ts'),
    join(RLM_ROOT, 'src', 'replay.ts'),
    join(RLM_ROOT, 'src', 'store.ts'),
    join(RLM_ROOT, 'src', 'selftest.ts'),
    join(RLM_ROOT, 'src', 'ui-contract.ts'),
  ]
  const rows = await Promise.all(sourcePaths.map(async path => {
    const info = await stat(path)
    return { path, sha256: await hashFile(path), mtimeMs: info.mtimeMs }
  }))
  const compiledPath = join(root, 'compiled', 'core.mjs')
  const compiledInfo = await stat(compiledPath)
  const compiled = await readFile(compiledPath, 'utf8')
  const freshRoot = await mkdtemp(join(TEMP_ROOT, 'rlmpar-rebuild-'))
  await compileSources(freshRoot)
  const outputs = ['core.mjs', 'acp-client.mjs', 'runtime.mjs']
  const freshOutputs = await Promise.all(outputs.map(async name => {
    const capturedPath = join(root, 'compiled', name)
    const rebuiltPath = join(freshRoot, 'compiled', name)
    const [capturedSha256, rebuiltSha256] = await Promise.all([hashFile(capturedPath), hashFile(rebuiltPath)])
    return { name, capturedPath, rebuiltPath, capturedSha256, rebuiltSha256, matches: capturedSha256 === rebuiltSha256 }
  }))
  return {
    sources: rows,
    compiledCore: { path: compiledPath, sha256: hashText(compiled), mtimeMs: compiledInfo.mtimeMs },
    sourceNoNewerThanCompiled: rows.every(row => row.mtimeMs <= compiledInfo.mtimeMs),
    compiledHasCurrentGateAndTerminalMarkers: [
      'terminalQuiescenceExpected',
      'remainingAutonomousContinuations',
      'RLM_NATIVE_GATE_FAILED',
    ].every(marker => compiled.includes(marker)),
    freshCompilation: {
      root: freshRoot,
      esbuild: 'same compileSources() settings: bundled local RLM source, node platform, node22 target, ESM, sourcemap false, packages external, temporary node_modules symlink',
      outputs: freshOutputs,
      matchesCaptured: freshOutputs.every(output => output.matches),
    },
  }
}

async function recheckExisting(root, selectedPackageRoot) {
  const original = JSON.parse(await readFile(join(root, 'report.json'), 'utf8'))
  const selectedManifestPath = join(selectedPackageRoot, 'assets', 'runtime-manifest.json')
  const selectedManifestInfo = await stat(selectedManifestPath)
  if (!selectedManifestInfo.isFile()) throw new Error(`missing verified runtime manifest in ${selectedPackageRoot}`)
  const nativeArm = original.arms?.native
  const pluginArm = original.arms?.plugin
  const files = original.evidence?.files
  if (!nativeArm || !pluginArm || !files?.nativeOpenAiRequests?.path || !files?.pluginPrimeRequests?.path || !files?.pluginDshRequests?.path || !files?.pluginJournalDshRequests?.path) {
    throw new Error('existing report does not contain the complete private request evidence required for recheck')
  }
  const [nativeRequests, pluginRaw, adapterRequests, journalDshRequests, sourceFingerprint] = await Promise.all([
    readFile(files.nativeOpenAiRequests.path, 'utf8').then(JSON.parse),
    readFile(files.pluginPrimeRequests.path, 'utf8').then(JSON.parse),
    readFile(files.pluginDshRequests.path, 'utf8').then(JSON.parse),
    readFile(files.pluginJournalDshRequests.path, 'utf8').then(JSON.parse),
    sourceFingerprintForCapture(root),
  ])
  const native = {
    paths: nativeArm.paths,
    sessionId: nativeArm.acpSessionId,
    launchArgs: nativeArm.launchArgs,
    requests: nativeRequests,
  }
  const plugin = {
    paths: pluginArm.paths,
    sessionId: pluginArm.acpSessionId,
    runId: pluginArm.runId,
    launchArgs: pluginArm.launchArgs,
    rawPrimeRequests: pluginRaw,
    requests: adapterRequests,
    journalDshRequests,
  }
  const comparison = buildComparison(native, plugin)
  const originalExecutionPassed = original.fatal === undefined
    && nativeArm.error === undefined
    && pluginArm.error === undefined
    && original.network?.realModelRequests === 0
    && nativeArm.requestCount === 3
    && pluginArm.requestCount === 3
    && nativeArm.actualGateContents === '42'
    && pluginArm.actualGateContents === '42'
    && cleanupPassed({ cleanup: nativeArm.cleanup }, { cleanup: pluginArm.cleanup })
  const status = originalExecutionPassed
    && sourceFingerprint.sourceNoNewerThanCompiled
    && sourceFingerprint.compiledHasCurrentGateAndTerminalMarkers
    && sourceFingerprint.freshCompilation.matchesCaptured
    && comparison.passed
    ? 'passed'
    : 'failed'
  const result = {
    formatVersion: REPORT_VERSION,
    kind: 'prime-native-rlm-parity-recheck',
    status,
    generatedAt: new Date().toISOString(),
    sourceCapture: {
      evidenceRoot: root,
      report: join(root, 'report.json'),
      originalRuntime: original.runtime,
      selectedPackageForFutureRun: {
        packageRoot: selectedPackageRoot,
        manifestPath: selectedManifestPath,
        manifestSha256: await hashFile(selectedManifestPath),
        note: 'This selector was validated but does not change the already-captured runtime; originalRuntime identifies that capture.',
      },
      sourceFingerprint,
      originalExecutionPassed,
      note: 'This recheck reuses the existing two-arm capture only when a fresh same-parameter esbuild compilation hashes identically for core.mjs, acp-client.mjs and runtime.mjs; it also records source mtimes and the current autonomous terminal/gate-failure markers.',
    },
    observed: {
      runtime: original.runtime,
      network: original.network,
      native: {
        localResponses: nativeArm.localResponses,
        actualGateContents: nativeArm.actualGateContents,
        actualPythonToolResults: nativeArm.actualPythonToolResults,
        cleanup: nativeArm.cleanup,
      },
      plugin: {
        localResponses: pluginArm.localResponses,
        actualGateContents: pluginArm.actualGateContents,
        actualPythonToolResults: pluginArm.actualPythonToolResults,
        cleanup: pluginArm.cleanup,
        shutdownReceipt: pluginArm.shutdownReceipt,
      },
    },
    evidence: original.evidence,
    comparison,
  }
  const resultPath = join(root, 'comparison-recheck.json')
  await writeJson(resultPath, result)
  process.stdout.write(`${JSON.stringify({ ...result, resultPath }, null, 2)}\n`)
  if (status !== 'passed') process.exitCode = 1
}

async function waitForRun(host, runId, ownerSessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    latest = await host.inspect(runId, ownerSessionId)
    if (['idle', 'failed', 'indeterminate', 'cancelled'].includes(latest.state)) return latest
    await delay(50)
  }
  throw new Error(`RlmHost did not settle before ${String(timeoutMs)}ms: ${JSON.stringify(latest)}`)
}

function directPaths(root) {
  const armRoot = join(root, 'native')
  return {
    root: armRoot,
    home: join(armRoot, 'home'),
    workspace: join(armRoot, 'workspace'),
    agentDir: join(armRoot, 'agent'),
    sessionDir: join(armRoot, 'agent', 'sessions'),
    socket: join(armRoot, 'p.sock'),
    acpJournal: join(armRoot, 'acp.jsonl'),
  }
}

async function runNativeArm({ root, runtime, AcpClient }) {
  const paths = directPaths(root)
  const result = {
    kind: 'native-acp',
    paths,
    launchArgs: directLaunchArguments(paths),
    initialized: undefined,
    promptResult: undefined,
    sessionId: undefined,
    updates: [],
    requests: [],
    responses: [],
    gate: undefined,
    toolResults: [],
    error: undefined,
    cleanup: { acpClose: undefined, acpDispose: undefined, shutdown: undefined, frontendExited: undefined, providerClosed: undefined },
  }
  let provider
  let child
  let client
  let journalTail = Promise.resolve()
  try {
    await Promise.all([
      mkdir(paths.home, { recursive: true, mode: 0o700 }),
      mkdir(paths.workspace, { recursive: true, mode: 0o700 }),
      mkdir(paths.agentDir, { recursive: true, mode: 0o700 }),
      mkdir(paths.sessionDir, { recursive: true, mode: 0o700 }),
    ])
    provider = await startNativeFakeProvider()
    await writePrimeSettings({ agentDir: paths.agentDir, baseUrl: provider.baseUrl })
    const env = onlyLocalEnvironment({ home: paths.home, agentDir: paths.agentDir, sessionDir: paths.sessionDir, socket: paths.socket, runtime })
    child = spawn(runtime.binary, result.launchArgs, { cwd: paths.workspace, env, stdio: ['pipe', 'pipe', 'pipe'] })
    client = new AcpClient(child, {
      record: async (direction, value) => {
        journalTail = journalTail.then(() => appendJsonLine(paths.acpJournal, { time: new Date().toISOString(), direction, value }))
        await journalTail
      },
      onUpdate: value => { result.updates.push(cloneEvidence(value)) },
      maxFrameBytes: 16 * 1024 * 1024,
    })
    result.initialized = cloneEvidence(await client.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'Solar RLM', version: '0.1.0-dev.0' },
      clientCapabilities: {},
    }, { timeoutMs: REQUEST_TIMEOUT_MS }))
    assertion(result.initialized?.protocolVersion === 1, 'direct Prime ACP initialize did not return protocolVersion 1')
    const created = await client.request('session/new', { cwd: paths.workspace, mcpServers: [] }, { timeoutMs: REQUEST_TIMEOUT_MS })
    assertion(typeof created?.sessionId === 'string', 'direct Prime ACP session/new did not return a sessionId')
    result.sessionId = created.sessionId
    result.promptResult = cloneEvidence(await client.request('session/prompt', {
      sessionId: result.sessionId,
      prompt: [{ type: 'text', text: TASK }],
    }, { timeoutMs: REQUEST_TIMEOUT_MS }))
    assertion(result.promptResult?.stopReason === 'end_turn', `direct Prime stopped as ${String(result.promptResult?.stopReason)}`)
    await journalTail
    result.requests = provider.requests
    result.responses = provider.responses
    result.gate = await readIfPresent(join(paths.workspace, 'gate.done'))
    result.toolResults = extractToolResults(result.requests)
    assertion(result.responses.length === 3, `direct Prime invoked ${String(result.responses.length)} local responses instead of 3`)
    assertion(result.gate === '42', `direct Prime gate.done was ${JSON.stringify(result.gate)} instead of "42"`)
    assertion(result.toolResults.some(value => String(value.content).includes('TOOL_42 42')), 'direct Prime history did not contain actual Python output TOOL_42 42')
  } catch (error) {
    result.error = recordError(error)
  } finally {
    const env = onlyLocalEnvironment({ home: paths.home, agentDir: paths.agentDir, sessionDir: paths.sessionDir, socket: paths.socket, runtime })
    if (client && result.sessionId) {
      try {
        await client.request('session/close', { sessionId: result.sessionId }, { timeoutMs: 15_000 })
        result.cleanup.acpClose = { ok: true }
      } catch (error) {
        result.cleanup.acpClose = { ok: false, error: recordError(error) }
      }
    } else {
      result.cleanup.acpClose = { ok: false, reason: 'ACP session was not created' }
    }
    if (client) {
      try {
        await client.dispose()
        result.cleanup.acpDispose = { ok: true }
      } catch (error) {
        result.cleanup.acpDispose = { ok: false, error: recordError(error) }
      }
    } else {
      result.cleanup.acpDispose = { ok: false, reason: 'ACP client was not created' }
    }
    try {
      await journalTail
    } catch (error) {
      result.cleanup.journal = { ok: false, error: recordError(error) }
    }
    if (child) {
      try {
        const shutdown = await runOwnedCommand(runtime.binary, ['shutdown', '--force', '--json'], { cwd: paths.workspace, env, timeoutMs: 20_000 })
        result.cleanup.shutdown = { ...shutdown, ok: shutdown.code === 0 && shutdown.signal === null && shutdown.timedOut === false }
      } catch (error) {
        result.cleanup.shutdown = { ok: false, error: recordError(error) }
      }
      const exited = await waitForExit(child, 5_000)
      if (!exited) {
        try { child.kill('SIGTERM') } catch { /* Only our own foreground process is addressed. */ }
      }
      result.cleanup.frontendExited = { ok: exited || await waitForExit(child, 5_000), exitCode: child.exitCode, signalCode: child.signalCode }
    } else {
      result.cleanup.shutdown = { ok: false, reason: 'direct Prime process was not created' }
      result.cleanup.frontendExited = { ok: false, reason: 'direct Prime process was not created' }
    }
    if (provider) {
      try {
        await provider.close()
        result.cleanup.providerClosed = { ok: provider.listening() === false }
      } catch (error) {
        result.cleanup.providerClosed = { ok: false, error: recordError(error) }
      }
    } else {
      result.cleanup.providerClosed = { ok: false, reason: 'local fake provider was not created' }
    }
  }
  return result
}

function pluginPaths(root, dataRoot) {
  const armRoot = join(root, 'plugin')
  return {
    root: armRoot,
    home: join(armRoot, 'home'),
    workspace: join(armRoot, 'workspace'),
    agentDir: undefined,
    sessionDir: undefined,
    socket: undefined,
    dataRoot,
  }
}

function findPluginSession(journal) {
  for (const row of journal) {
    const value = row?.value
    if (value?.type !== 'acp' || value.direction !== 'receive') continue
    const sessionId = value.value?.result?.sessionId
    if (typeof sessionId === 'string') return sessionId
  }
  return undefined
}

async function runPluginArm({ root, dataRoot, packageRoot, RlmHost }) {
  const paths = pluginPaths(root, dataRoot)
  const result = {
    kind: 'rlmhost-dsh-adapter-acp',
    paths,
    runId: undefined,
    sessionId: undefined,
    start: undefined,
    terminal: undefined,
    launchArgs: undefined,
    requests: [],
    journalDshRequests: [],
    rawPrimeRequests: [],
    responses: [],
    gate: undefined,
    toolResults: [],
    shutdownReceipt: undefined,
    error: undefined,
    cleanup: { cancel: undefined, dispose: undefined, bridgeHttpClosed: undefined },
  }
  const adapter = new FakeAdapter()
  const llm = new FakeDshLlm(adapter)
  const owner = { sessionId: 'parity-owner-session', route: { ...MODEL_ROUTE } }
  const restore = replaceProcessEnvironment({
    HOME: paths.home,
    USER: 'rlm-parity',
    LOGNAME: 'rlm-parity',
    TMPDIR: TEMP_ROOT,
    PI_OFFLINE: '1',
    UV_OFFLINE: '1',
    PYTHONNOUSERSITE: '1',
    DO_NOT_TRACK: '1',
    PRIME_AGENT_TELEMETRY_DISABLED: '1',
  })
  let host
  let runDirectory
  try {
    await Promise.all([
      mkdir(paths.home, { recursive: true, mode: 0o700 }),
      mkdir(paths.workspace, { recursive: true, mode: 0o700 }),
      mkdir(join(paths.home, 'tmp'), { recursive: true, mode: 0o700 }),
    ])
    host = new RlmHost({ llm }, dataRoot, packageRoot, 1024 * 1024, { factoryEnabled: false, harnessRefinements: true })
    result.start = cloneEvidence(await host.start({
      task: TASK,
      cwd: paths.workspace,
      label: 'native-parity-fixed-task',
      maxModelRequests: MAX_REQUESTS,
      maxWallTimeMs: REQUEST_TIMEOUT_MS,
      autonomous: { ...AUTONOMOUS },
    }, owner))
    result.runId = result.start.runId
    runDirectory = join(dataRoot, 'runs', result.runId)
    result.terminal = cloneEvidence(await waitForRun(host, result.runId, owner.sessionId, REQUEST_TIMEOUT_MS))
    assertion(result.terminal.state === 'idle', `RlmHost terminal state was ${String(result.terminal.state)}`)
    result.gate = await readIfPresent(join(paths.workspace, 'gate.done'))
    assertion(result.gate === '42', `RlmHost gate.done was ${JSON.stringify(result.gate)} instead of "42"`)
    const journal = await readJsonLines(join(runDirectory, 'journal.jsonl'))
    const intents = journal.map(row => row?.value).filter(value => value?.type === 'model-intent')
    const launches = journal.map(row => row?.value).filter(value => value?.type === 'native-launch')
    result.rawPrimeRequests = intents.map((value, index) => ({ ordinal: index + 1, body: value.primeRequest }))
    result.journalDshRequests = intents.map((value, index) => ({ ordinal: index + 1, request: value.dshRequest }))
    result.launchArgs = launches.at(-1)?.args
    result.sessionId = findPluginSession(journal)
    result.paths.agentDir = join(runDirectory, 'prime-state')
    result.paths.sessionDir = join(result.paths.agentDir, 'sessions')
    result.paths.socket = join(dataRoot, 's', `${result.runId.slice(0, 12)}.sock`)
    result.requests = adapter.requests
    result.responses = adapter.responses
    result.toolResults = extractToolResults(result.rawPrimeRequests)
    assertion(result.responses.length === 3, `RlmHost invoked ${String(result.responses.length)} local responses instead of 3`)
    assertion(result.rawPrimeRequests.length === 3, `RlmHost journal has ${String(result.rawPrimeRequests.length)} Prime request(s) instead of 3`)
    assertion(result.toolResults.some(value => String(value.content).includes('TOOL_42 42')), 'RlmHost Prime history did not contain actual Python output TOOL_42 42')
  } catch (error) {
    result.error = recordError(error)
  } finally {
    if (host && result.runId) {
      try {
        result.cleanup.cancel = cloneEvidence(await host.cancel(result.runId, owner.sessionId))
      } catch (error) {
        result.cleanup.cancel = { ok: false, error: recordError(error) }
      }
    } else {
      result.cleanup.cancel = { ok: false, reason: 'RlmHost run was not created' }
    }
    if (host) {
      try {
        await host.dispose()
        result.cleanup.dispose = { ok: true }
      } catch (error) {
        result.cleanup.dispose = { ok: false, error: recordError(error) }
      }
    } else {
      result.cleanup.dispose = { ok: false, reason: 'RlmHost was not created' }
    }
    if (runDirectory) {
      try {
        const receipt = await readIfPresent(join(runDirectory, 'prime-state', 'solar-shutdown-receipt.json'))
        result.shutdownReceipt = receipt === undefined ? undefined : JSON.parse(receipt)
        result.cleanup.bridgeHttpClosed = { ok: result.cleanup.cancel?.state === 'cancelled' && receipt !== undefined }
      } catch (error) {
        result.cleanup.bridgeHttpClosed = { ok: false, error: recordError(error) }
      }
    } else {
      result.cleanup.bridgeHttpClosed = { ok: false, reason: 'RlmHost run directory was not created' }
    }
    restore()
  }
  return result
}

async function collectEvidence(root, native, plugin) {
  const evidence = join(root, 'evidence')
  const paths = {
    nativeOpenAiRequests: join(evidence, 'native-openai-requests.json'),
    nativeResponses: join(evidence, 'native-local-responses.json'),
    nativeAcp: native.paths.acpJournal,
    pluginPrimeRequests: join(evidence, 'plugin-prime-openai-requests.json'),
    pluginDshRequests: join(evidence, 'plugin-fake-adapter-dsh-requests.json'),
    pluginJournalDshRequests: join(evidence, 'plugin-journal-dsh-requests.json'),
    pluginResponses: join(evidence, 'plugin-local-responses.json'),
  }
  await Promise.all([
    writeJson(paths.nativeOpenAiRequests, native.requests),
    writeJson(paths.nativeResponses, native.responses),
    writeJson(paths.pluginPrimeRequests, plugin.rawPrimeRequests),
    writeJson(paths.pluginDshRequests, plugin.requests),
    writeJson(paths.pluginJournalDshRequests, plugin.journalDshRequests),
    writeJson(paths.pluginResponses, plugin.responses),
  ])
  const files = {}
  for (const [name, path] of Object.entries(paths)) {
    const contents = await readIfPresent(path)
    files[name] = contents === undefined
      ? { path, present: false }
      : { path, present: true, sha256: hashText(contents), bytes: Buffer.byteLength(contents) }
  }
  return { root: evidence, files }
}

function reportArm(arm) {
  return {
    kind: arm.kind,
    paths: arm.paths,
    runId: arm.runId,
    acpSessionId: arm.sessionId,
    launchArgs: arm.launchArgs,
    initialized: arm.initialized,
    start: arm.start,
    terminal: arm.terminal,
    promptResult: arm.promptResult,
    localResponses: arm.responses,
    requestCount: arm.requests.length || arm.rawPrimeRequests?.length || 0,
    actualGateContents: arm.gate,
    actualPythonToolResults: arm.toolResults,
    cleanup: arm.cleanup,
    shutdownReceipt: arm.shutdownReceipt,
    error: arm.error,
  }
}

function cleanupPassed(native, plugin) {
  return native.cleanup.acpDispose?.ok === true
    && native.cleanup.providerClosed?.ok === true
    && native.cleanup.shutdown?.ok === true
    && native.cleanup.frontendExited?.ok === true
    && plugin.cleanup.cancel?.state === 'cancelled'
    && plugin.cleanup.dispose?.ok === true
    && plugin.cleanup.bridgeHttpClosed?.ok === true
}

async function main() {
  const commandLine = parseCommandLine(process.argv.slice(2))
  if (commandLine.recheckRoot !== undefined) {
    await recheckExisting(commandLine.recheckRoot, commandLine.packageRoot)
    return
  }
  const packageRoot = commandLine.packageRoot
  const root = await mkdtemp(join(TEMP_ROOT, 'rlmpar-'))
  let compiled
  let runtime
  let runtimeManifest
  let runtimeManifestText
  let native
  let plugin
  let fatal
  let evidence
  let comparison
  try {
    assertion(process.platform === 'darwin' && process.arch === 'arm64', 'native parity tool only supports darwin arm64')
    assertion(Number.parseInt(process.versions.node.split('.')[0], 10) === 22, `run this tool with Node 22, got ${process.versions.node}`)
    const manifestPath = join(packageRoot, 'assets', 'runtime-manifest.json')
    const archivePath = join(packageRoot, 'assets', 'runtime.tar.gz')
    const [packageInfo, archiveInfo] = await Promise.all([stat(manifestPath), stat(archivePath)])
    assertion(packageInfo.isFile(), `missing verified runtime manifest in ${packageRoot}`)
    assertion(archiveInfo.isFile(), `missing verified runtime archive in ${packageRoot}`)
    compiled = await compileSources(root)
    runtime = await compiled.loadRuntime(packageRoot, join(root, 'plugin-data'))
    runtimeManifestText = await readFile(manifestPath, 'utf8')
    runtimeManifest = JSON.parse(runtimeManifestText)
    const binarySha256 = await hashFile(runtime.binary)
    assertion(binarySha256 === runtimeManifest.binarySha256, 'normal RuntimeManager fingerprint check did not produce the manifest binary')
    native = await runNativeArm({ root, runtime, AcpClient: compiled.AcpClient })
    plugin = await runPluginArm({ root, dataRoot: join(root, 'plugin-data'), packageRoot, RlmHost: compiled.RlmHost })
    evidence = await collectEvidence(root, native, plugin)
    comparison = buildComparison(native, plugin)
  } catch (error) {
    fatal = recordError(error)
  }
  if (native && plugin && evidence === undefined) {
    try { evidence = await collectEvidence(root, native, plugin) } catch (error) { fatal ??= recordError(error) }
  }
  const realRequests = 0
  const status = fatal === undefined
    && native?.error === undefined
    && plugin?.error === undefined
    && comparison?.passed === true
    && cleanupPassed(native, plugin)
    ? 'passed'
    : 'failed'
  const report = {
    formatVersion: REPORT_VERSION,
    kind: 'prime-native-rlm-parity',
    status,
    generatedAt: new Date().toISOString(),
    evidenceRoot: root,
    frozenTask: {
      task: TASK,
      model: { contextWindow: 8192, maxTokens: 512, thinking: 'off' },
      autonomous: { ...AUTONOMOUS, maxWallTimeMs: REQUEST_TIMEOUT_MS, maxModelRequests: MAX_REQUESTS },
      expectedLocalResponses: ['EARLY_STOP', 'python_repl writes gate.done=42 and prints TOOL_42 42', 'DONE'],
      fakeAdapterToolDelta: 'whitespace-padded provisional delta; block-end supplies authoritative JSON',
    },
    runtime: runtime === undefined ? undefined : {
      packageRoot,
      manifestSha256: runtimeManifestText === undefined ? undefined : hashText(runtimeManifestText),
      binary: runtime.binary,
      python: runtime.python,
      packageDir: runtime.packageDir,
      fingerprint: runtime.fingerprint,
      binarySha256: runtimeManifest?.binarySha256,
      manifestPrimeCommit: runtimeManifest?.primeCommit,
      sameBinaryForBothArms: true,
    },
    network: {
      realModelRequests: realRequests,
      localNativeHttpRequests: native?.requests?.length ?? 0,
      localFakeAdapterRequests: plugin?.requests?.length ?? 0,
      externalNetworkEndpointsConfigured: [],
      isolation: 'Prime received only loopback OpenAI settings or an in-process FakeAdapter; the child environment is an allowlist with offline and telemetry-disabled flags.',
    },
    arms: {
      native: native === undefined ? undefined : reportArm(native),
      plugin: plugin === undefined ? undefined : reportArm(plugin),
    },
    comparison,
    evidence,
    fatal,
  }
  const reportPath = join(root, 'report.json')
  await writeJson(reportPath, report)
  process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`)
  if (status !== 'passed') process.exitCode = 1
}

main().catch(async error => {
  process.stderr.write(`rlm-native-parity: ${errorText(error)}\n`)
  process.exitCode = 1
})
