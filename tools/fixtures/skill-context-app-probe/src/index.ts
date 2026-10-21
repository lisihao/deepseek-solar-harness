/**
 * Internal installed-host acceptance probe for skill-context.
 *
 * Its first app-ready host observation is only the global bounded-search
 * registration; host configuration is read later only to resolve the receipt
 * path. The Desktop preset scopes the official `skill` loader to each Agent,
 * which this fixture reproduces only inside its new isolated Context. Every
 * Session, AgentRegistry, SkillRegistry, and fake LLM used below belongs to a
 * newly created isolated Context from request-harness, so this probe cannot
 * write a user's session or trigger host-wide memory/browser/model plugins.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type GenerateOptions, type Message } from '@deepseek-ai/dsh-llm'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  createLoopAgent,
  followLoopAgent,
  mountRequestHarness,
  textResponse,
  toolCallResponse,
} from '../../../../incubator/skill-context/tests/fixtures/request-harness.js'

const INSTALLED_PLUGIN = '@lisihao/dsh-solar-skill-context'
const MARKER_ENV = 'SOLAR_SKILL_CONTEXT_APP_PROBE_MARKER'
const RECEIPT_SEGMENTS = ['solar', 'skill-context', 'app-keyless-acceptance.json']
const TIMEOUT_MS = 60_000
const TARGET_SKILL = 'latest-skill-1476'
const TARGET_BODY = 'APP_PROBE_LATEST_SKILL_BODY'

type UnknownRecord = Record<string, unknown>

interface AppReady {
  onReady(callback: () => void): () => void
}

interface InstalledSkillContextModule {
  readonly name?: string
  readonly inject?: readonly string[]
  readonly Config?: unknown
  readonly DISCOVERY_NOTICE?: string
  readonly apply?: (ctx: Context, config?: unknown) => void
  readonly retireHistoricalCatalogs?: unknown
}

interface InstalledPluginEvidence {
  readonly importPath: string
  readonly libIndexSha256: string
  readonly rc2Dependencies: Readonly<Record<string, string>>
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function serialiseError(error: unknown): { name: string; message: string; code?: string } {
  if (error instanceof Error) {
    const candidate = error as Error & { code?: unknown }
    return {
      name: error.name || 'Error',
      message: error.message || String(error),
      ...typeof candidate.code === 'string' ? { code: candidate.code } : {},
    }
  }
  return { name: 'UnknownError', message: String(error) }
}

function hostGet(ctx: Context, key: string): unknown {
  return (ctx as unknown as { get(name: string): unknown }).get(key)
}

/** The first app-ready operation: observe only the host's global tool schemas. */
function verifyHostTools(ctx: Context): {
  readonly globalTools: readonly ['solar_skill_search']
  readonly officialSkillInHostGlobal: boolean
} {
  const tools = hostGet(ctx, 'tools') as { schemas?: () => readonly { name?: unknown }[] } | undefined
  assert(tools !== undefined && typeof tools.schemas === 'function', 'APP_PROBE_HOST_TOOLS_UNAVAILABLE: host tools service is unavailable')
  const names = new Set(tools.schemas().map(schema => schema.name).filter((name): name is string => typeof name === 'string'))
  assert(names.has('solar_skill_search'), 'APP_PROBE_HOST_TOOL_MISSING: solar_skill_search is not registered')
  return {
    globalTools: ['solar_skill_search'],
    officialSkillInHostGlobal: names.has('skill'),
  }
}

function configuredDshHome(ctx: Context): string | undefined {
  const config = hostGet(ctx, 'hostConfig') ?? hostGet(ctx, 'hostconfig')
  if (!isRecord(config)) return undefined
  if (typeof config.dshHome === 'string') return config.dshHome
  const dsh = config.dsh
  if (isRecord(dsh) && typeof dsh.home === 'string') return dsh.home
  return undefined
}

/** Use the published home-paths boundary, with host configuration when exposed. */
function resolveDshHomePath(ctx: Context): string {
  return resolveDshHome(configuredDshHome(ctx))
}

function receiptPath(ctx: Context): { readonly path: string; readonly destination: 'dsh-home' | 'scratch-marker' } {
  const marker = process.env[MARKER_ENV]?.trim()
  if (marker) return { path: marker, destination: 'scratch-marker' }
  return { path: join(resolveDshHomePath(ctx), ...RECEIPT_SEGMENTS), destination: 'dsh-home' }
}

async function writeReceipt(path: string, receipt: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
}

function sourceKind(message: GenerateOptions['messages'][number] | Message): string | undefined {
  return 'source' in message && message.source !== undefined
    ? (message.source as { kind?: unknown }).kind as string | undefined
    : undefined
}

function messageText(message: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
  return message.content.map(block => block.type === 'text' ? block.text ?? '' : '').join('\n')
}

function catalogEntries(size: number, revision: string): readonly { readonly name: string; readonly description: string }[] {
  return Array.from({ length: size }, (_, index) => ({
    name: `historical-${revision}-skill-${String(index).padStart(4, '0')}`,
    description: `Historical full catalog ${revision} entry ${index}`,
  }))
}

function fullCatalogMessage(size: number, revision: string) {
  const entries = catalogEntries(size, revision)
  return createUserMessage({
    content: [{
      type: 'text',
      text: [
        '<system-reminder>',
        `Historical catalog ${revision}; this full body must not reach the repaired request.`,
        '<available_skills>',
        ...entries.map(entry => `- \`${entry.name}\`: ${entry.description}`),
        '</available_skills>',
        '</system-reminder>',
      ].join('\n'),
    }],
    source: { kind: 'skill-catalog', form: 'catalog', entries },
  } as never)
}

function historicalSeed(): readonly SessionEvent[] {
  const session = Session.create(SessionId('solar-skill-context-app-probe-history'))
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Historical user message before catalog one.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('user/message', fullCatalogMessage(1_467, 'one'), { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Historical user message between catalog one and two.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('user/message', fullCatalogMessage(1_475, 'two'), { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Historical user message after catalog two.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('user/message', fullCatalogMessage(1_477, 'three'), { surfaceOp: 'append' })
  return session.snapshotEvents()
}

function registerCurrentSkills(ctx: Context): void {
  for (let index = 0; index < 1_477; index += 1) {
    const name = index === 1_476 ? TARGET_SKILL : `current-skill-${String(index).padStart(4, '0')}`
    ctx.skills.register({
      name,
      description: index === 1_476
        ? 'The latest exact skill that proves the current 1,477-entry catalog remains searchable.'
        : `Current isolated catalog skill ${index}`,
      content: index === 1_476 ? TARGET_BODY : `CURRENT_SKILL_BODY_${index}`,
      source: 'runtime',
      invocation: { modelInvocable: true, userInvocable: true },
    })
  }
}

function toolResultFor(events: readonly SessionEvent[], name: string): SessionEvent<'tool/result'> | undefined {
  const call = events.find(event => event.type === 'tool/call' && event.data.name === name)
  if (call?.type !== 'tool/call') return undefined
  const result = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === call.data.callId)
  return result?.type === 'tool/result' ? result : undefined
}

function resolvedFilePath(resolved: string): string {
  return resolved.startsWith('file:') ? fileURLToPath(resolved) : resolved
}

async function installedRc2DependencyVersions(): Promise<Readonly<Record<string, string>>> {
  const packages = [
    '@deepseek-ai/dsh-agent-loop',
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-skill',
    '@deepseek-ai/dsh-tool-skill',
  ] as const
  const versions: Record<string, string> = {}
  for (const packageName of packages) {
    const manifestPath = resolvedFilePath(import.meta.resolve(`${packageName}/package.json`))
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { version?: unknown }
    assert(typeof manifest.version === 'string', `APP_PROBE_DEPENDENCY_VERSION_INVALID: ${packageName} has no package version`)
    assert(manifest.version === '0.2.1-rc.2', `APP_PROBE_DEPENDENCY_VERSION_MISMATCH: ${packageName} is ${manifest.version}`)
    versions[packageName] = manifest.version
  }
  return versions
}

async function installedSkillContext(): Promise<{ plugin: InstalledSkillContextModule; evidence: InstalledPluginEvidence }> {
  const importPath = resolvedFilePath(import.meta.resolve(INSTALLED_PLUGIN))
  const source = await readFile(importPath)
  const plugin = await import(INSTALLED_PLUGIN) as InstalledSkillContextModule
  assert(typeof plugin.apply === 'function', 'APP_PROBE_INSTALLED_PLUGIN_INVALID: installed skill-context has no apply()')
  assert(typeof plugin.retireHistoricalCatalogs === 'function', 'APP_PROBE_INSTALLED_PLUGIN_INVALID: installed skill-context has no retireHistoricalCatalogs()')
  assert(typeof plugin.DISCOVERY_NOTICE === 'string', 'APP_PROBE_INSTALLED_PLUGIN_INVALID: installed skill-context has no discovery notice')
  return {
    plugin,
    evidence: {
      importPath,
      libIndexSha256: createHash('sha256').update(source).digest('hex'),
      rc2Dependencies: await installedRc2DependencyVersions(),
    },
  }
}

async function runIsolatedAcceptance(signal: AbortSignal): Promise<UnknownRecord> {
  signal.throwIfAborted()
  const harness = await mountRequestHarness([
    toolCallResponse('app-probe-search-latest', 'solar_skill_search', { query: TARGET_SKILL, offset: 0 }),
    toolCallResponse('app-probe-load-latest', 'skill', { name: TARGET_SKILL }),
    textResponse('Isolated keyless acceptance completed.'),
  ], { scopedSkillTool: true })
  let agent: Awaited<ReturnType<typeof createLoopAgent>> | undefined
  let cancelAgent: (() => void) | undefined
  try {
    registerCurrentSkills(harness.ctx)
    const installed = await installedSkillContext()
    const plugin = installed.plugin
    signal.throwIfAborted()
    await harness.ctx.plugin(plugin)
    assert(harness.ctx.tools.get('skill') === undefined,
      'APP_PROBE_GLOBAL_SKILL_VISIBLE: isolated Desktop-shaped harness mounted the official loader globally')
    assert(harness.ctx.tools.get('solar_skill_search') !== undefined,
      'APP_PROBE_GLOBAL_SEARCH_MISSING: isolated bounded search is not globally registered')
    const seed = historicalSeed()
    agent = await createLoopAgent(harness, 'solar-skill-context-app-probe', { seed })
    assert(harness.ctx.tools.get('skill', agent.agent) !== undefined,
      'APP_PROBE_SCOPED_SKILL_MISSING: isolated Agent does not resolve the official skill loader')
    assert(harness.ctx.tools.get('solar_skill_search', agent.agent) !== undefined,
      'APP_PROBE_SCOPED_SEARCH_MISSING: isolated Agent does not resolve bounded search')
    cancelAgent = () => {
      agent?.agent.cancel({ kind: 'hook', reason: 'skill-context app probe cancelled' }, { keepInbox: true })
    }
    signal.addEventListener('abort', cancelAgent, { once: true })
    await followLoopAgent(agent, 'Run only the isolated keyless skill-context acceptance path.')
    signal.throwIfAborted()

    const requests = harness.adapter.requests
    assert(requests.length === 3, `APP_PROBE_FAKE_PLAN_MISMATCH: expected 3 fake requests, got ${requests.length}`)
    const requestChecks = requests.map((request, index) => {
      const catalogs = request.messages.filter(message => sourceKind(message) === 'skill-catalog')
      const notices = request.messages.filter(message => sourceKind(message) === 'solar-skill-context')
      assert(catalogs.length === 0, `APP_PROBE_CATALOG_VISIBLE: request ${index + 1} retained a full skill catalog`)
      assert(notices.length === 1, `APP_PROBE_NOTICE_COUNT: request ${index + 1} has ${notices.length} discovery notices`)
      const notice = messageText(notices[0]!)
      assert(notice === plugin.DISCOVERY_NOTICE, `APP_PROBE_NOTICE_CONTENT: request ${index + 1} has an unexpected discovery notice`)
      assert(Buffer.byteLength(notice, 'utf8') < 1_024, `APP_PROBE_NOTICE_TOO_LARGE: request ${index + 1} notice exceeds 1,023 bytes`)
      const tools = request.tools?.map(tool => tool.name) ?? []
      assert(tools.includes('skill') && tools.includes('solar_skill_search'), `APP_PROBE_TOOL_SURFACE: request ${index + 1} lacks a required tool`)
      return { messageCount: request.messages.length, tools }
    })

    const events = agent.agent.session.snapshotEvents() as readonly SessionEvent[]
    assert(JSON.stringify(events.slice(0, seed.length)) === JSON.stringify(seed), 'APP_PROBE_LOG_MUTATED: historical event prefix changed')
    const catalogSeqs = seed.filter(event => event.type === 'user/message' && event.data.source.kind === 'skill-catalog').map(event => event.seq)
    const retirements = events.filter(event => event.type === 'developer/message'
      && event.data.message.source.kind === 'solar-skill-context'
      && event.data.message.content.length === 0)
    assert(retirements.length === 3, `APP_PROBE_REPLACEMENT_COUNT: expected 3 catalog replacements, got ${retirements.length}`)
    assert(JSON.stringify(retirements.map(event => event.sourceEventSeqs)) === JSON.stringify(catalogSeqs.map(seq => [seq])),
      'APP_PROBE_REPLACEMENT_SCOPE: a replacement did not cite exactly one historical catalog')

    const searchResult = toolResultFor(events, 'solar_skill_search')
    assert(searchResult !== undefined && searchResult.data.message.isError === false, 'APP_PROBE_SEARCH_FAILED: bounded search returned an error')
    const searchValue = JSON.parse(messageText(searchResult.data.message)) as { matches?: readonly { name?: unknown }[]; totalMatches?: unknown }
    assert(searchValue.matches?.some(match => match.name === TARGET_SKILL), 'APP_PROBE_SEARCH_MISSING_LATEST: bounded search did not find the newest skill')
    assert(searchValue.totalMatches === 1, `APP_PROBE_SEARCH_UNEXPECTED_TOTAL: exact search total is ${String(searchValue.totalMatches)}`)

    const loaded = toolResultFor(events, 'skill')
    assert(loaded !== undefined && loaded.data.message.isError === false, 'APP_PROBE_OFFICIAL_SKILL_FAILED: official skill tool returned an error')
    assert(messageText(loaded.data.message).includes(TARGET_BODY), 'APP_PROBE_OFFICIAL_SKILL_BODY: official skill tool did not load the latest body')

    return {
      installedPlugin: {
        importPath: installed.evidence.importPath,
        libIndexSha256: installed.evidence.libIndexSha256,
        rc2Dependencies: installed.evidence.rc2Dependencies,
        exports: { apply: true, retireHistoricalCatalogs: true },
      },
      isolatedSkillCount: 1_477,
      fakeModelCalls: requests.length,
      requestChecks,
      historicalCatalogsRetired: retirements.length,
      search: { totalMatches: searchValue.totalMatches, latest: TARGET_SKILL },
      officialSkill: TARGET_SKILL,
      isolatedSessionEventCount: events.length,
      flushCount: harness.flushes.count,
    }
  } finally {
    if (cancelAgent !== undefined) signal.removeEventListener('abort', cancelAgent)
    await harness.cleanup()
  }
}

async function withDeadline<T>(parent: AbortSignal, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const abortFromParent = () => controller.abort(parent.reason)
  if (parent.aborted) abortFromParent()
  else parent.addEventListener('abort', abortFromParent, { once: true })
  const operation = Promise.resolve().then(() => action(controller.signal))
  // Keep a late rejection observed if the deadline wins the race.
  operation.catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`APP_PROBE_TIMEOUT: isolated acceptance exceeded ${TIMEOUT_MS}ms`)
      controller.abort(error)
      reject(error)
    }, TIMEOUT_MS)
    timer.unref?.()
  })
  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    parent.removeEventListener('abort', abortFromParent)
  }
}

async function runAndRecord(ctx: Context, lifecycleSignal: AbortSignal): Promise<void> {
  const startedAt = new Date().toISOString()
  let target: ReturnType<typeof receiptPath> | undefined
  let host: UnknownRecord | undefined
  let checks: UnknownRecord = {}
  let failure: ReturnType<typeof serialiseError> | undefined
  try {
    lifecycleSignal.throwIfAborted()
    // This must stay before all other host interactions.
    host = verifyHostTools(ctx)
    target = receiptPath(ctx)
    checks = await withDeadline(lifecycleSignal, runIsolatedAcceptance)
  } catch (error) {
    failure = serialiseError(error)
    try {
      target ??= receiptPath(ctx)
    } catch (pathError) {
      failure = {
        ...failure,
        message: `${failure.message}; APP_PROBE_RECEIPT_PATH_FAILED: ${serialiseError(pathError).message}`,
      }
    }
  }

  const finishedAt = new Date().toISOString()
  let receipt: UnknownRecord = {
    formatVersion: 1,
    kind: 'solar-skill-context-app-keyless-acceptance',
    keyless: true,
    isolated: true,
    userSessionWrites: 0,
    realProviderCalls: 0,
    startedAt,
    finishedAt,
    ...host === undefined ? {} : { host },
    checks,
    ok: failure === undefined,
    ...failure === undefined ? {} : { error: failure },
  }

  if (target === undefined) {
    receipt = {
      ...receipt,
      ok: false,
      error: failure ?? { name: 'ReceiptPathError', message: 'APP_PROBE_RECEIPT_PATH_FAILED: no receipt path is available' },
    }
  } else {
    receipt = { ...receipt, receiptPath: target.path, receiptDestination: target.destination }
    try {
      await writeReceipt(target.path, receipt)
    } catch (error) {
      receipt = {
        ...receipt,
        ok: false,
        error: { name: 'ReceiptWriteError', message: `APP_PROBE_RECEIPT_WRITE_FAILED: ${serialiseError(error).message}` },
      }
    }
  }
  process.stdout.write(`${JSON.stringify(receipt)}\n`)
}

export const name = 'solar-skill-context-app-probe'
export const inject = ['appReady']

export function apply(ctx: Context): () => void {
  const ready = hostGet(ctx, 'appReady') as AppReady | undefined
  if (ready === undefined || typeof ready.onReady !== 'function') {
    throw new Error('APP_PROBE_APP_READY_UNAVAILABLE: appReady service is unavailable')
  }
  let started = false
  let lifecycle: AbortController | undefined
  const cancelReady = ready.onReady(() => {
    if (started) return
    started = true
    lifecycle = new AbortController()
    void runAndRecord(ctx, lifecycle.signal).catch(error => {
      // runAndRecord catches normal probe failures. This is only a final guard
      // for an unexpected control-path failure and still emits one JSON record.
      process.stdout.write(`${JSON.stringify({
        formatVersion: 1,
        kind: 'solar-skill-context-app-keyless-acceptance',
        keyless: true,
        isolated: true,
        userSessionWrites: 0,
        realProviderCalls: 0,
        ok: false,
        error: serialiseError(error),
      })}\n`)
    })
  })
  return () => {
    cancelReady()
    lifecycle?.abort(new Error('APP_PROBE_LIFECYCLE_CANCELLED: plugin disposed before acceptance completed'))
  }
}
