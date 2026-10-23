/**
 * Installed-host acceptance probe for tool-context.
 *
 * The Host only loads this bundle and provides appReady. All behavior under
 * test runs in a newly created Cordis Context with the published rc.2
 * AgentLoop/ToolRuntime, an in-memory PTC substrate, and a fake LLM adapter.
 * No provider, browser, Host profile session, or credential is used.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { defineTool, renderToolsSdk, type JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import {
  createLoopAgent,
  followLoopAgent,
  mountRequestHarness,
  textResponse,
  toolCallResponse,
} from '../../../../incubator/tool-context/tests/fixtures/request-harness.js'

const INSTALLED_PLUGIN = '@lisihao/dsh-solar-tool-context'
const MARKER_ENV = 'SOLAR_TOOL_CONTEXT_PROBE_MARKER'
const EXIT_ENV = 'SOLAR_TOOL_CONTEXT_PROBE_EXIT'
const RECEIPT_SEGMENTS = ['solar', 'tool-context', 'app-keyless-acceptance.json']
const TIMEOUT_MS = 60_000
const TARGET_TOOL = 'probe_business'
const TARGET_MARKER = 'TOOL_CONTEXT_PROBE_FULL_SCHEMA_MARKER'

type UnknownRecord = Record<string, unknown>

interface AppReady {
  onReady(callback: () => void): () => void
}

interface InstalledToolContextModule {
  readonly name?: string
  readonly inject?: readonly string[]
  readonly apply?: (ctx: Context, config?: unknown) => void
  readonly DEFAULT_CONFIG?: unknown
}

interface InstalledPluginEvidence {
  readonly importPath: string
  readonly libIndexSha256: string
  readonly rc2Dependencies: Readonly<Record<string, string>>
}

interface CatalogSnapshot {
  readonly scope: 'ptc-preset' | 'global'
  readonly entries: readonly (ToolSchema & { output: JsonSchemaNode })[]
}

/** Read public metadata only; no Agent, request, or business call is created. */
async function hostCatalog(ctx: Context): Promise<CatalogSnapshot> {
  const tools = hostGet(ctx, 'tools') as {
    schemas(scope?: object): ToolSchema[]
    get(name: string, scope?: object): { output: { schema: JsonSchemaNode } } | undefined
  }
  const presets = hostGet(ctx, 'agentPresets') as { acquireScope(id: string): Promise<{ key: object; [Symbol.asyncDispose](): Promise<void> }> } | undefined
  const lease = presets === undefined ? undefined : await presets.acquireScope('ptc')
  try {
    const entries = tools.schemas(lease?.key).filter(schema => !['run_code', 'solar_tool_search', 'solar_tool_load', TARGET_TOOL].includes(schema.name)).map(schema => {
      const definition = tools.get(schema.name, lease?.key)
      assert(definition !== undefined, `APP_PROBE_CATALOG_CHANGED: ${schema.name} disappeared`)
      return structuredClone({ ...schema, output: definition.output.schema })
    })
    return { scope: lease === undefined ? 'global' : 'ptc-preset', entries }
  } finally {
    await lease?.[Symbol.asyncDispose]()
  }
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
      ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
    }
  }
  return { name: 'UnknownError', message: String(error) }
}

function hostGet(ctx: Context, key: string): unknown {
  return (ctx as unknown as { get(name: string): unknown }).get(key)
}

function textOf(message: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
  return message.content.map(block => block.type === 'text' ? block.text ?? '' : '').join('\n')
}

function systemText(request: { readonly messages: readonly { readonly role: string; readonly content: readonly { readonly type: string; readonly text?: string }[] }[] }): string {
  return request.messages.filter(message => message.role === 'system').map(textOf).join('\n')
}

/** The first Host observation only confirms target helper registration. */
function verifyHostTools(ctx: Context): { readonly globalTools: readonly ['solar_tool_search', 'solar_tool_load'] } {
  const tools = hostGet(ctx, 'tools') as { schemas?: () => readonly { name?: unknown }[] } | undefined
  assert(tools !== undefined && typeof tools.schemas === 'function', 'APP_PROBE_HOST_TOOLS_UNAVAILABLE: host tools service is unavailable')
  const names = new Set(tools.schemas().map(schema => schema.name).filter((name): name is string => typeof name === 'string'))
  assert(names.has('solar_tool_search'), 'APP_PROBE_HOST_TOOL_MISSING: solar_tool_search is not registered')
  assert(names.has('solar_tool_load'), 'APP_PROBE_HOST_TOOL_MISSING: solar_tool_load is not registered')
  return { globalTools: ['solar_tool_search', 'solar_tool_load'] }
}

function configuredDshHome(ctx: Context): string | undefined {
  const config = hostGet(ctx, 'hostConfig') ?? hostGet(ctx, 'hostconfig')
  if (!isRecord(config)) return undefined
  if (typeof config.dshHome === 'string') return config.dshHome
  const dsh = config.dsh
  return isRecord(dsh) && typeof dsh.home === 'string' ? dsh.home : undefined
}

function receiptPath(ctx: Context): { readonly path: string; readonly destination: 'dsh-home' | 'scratch-marker' } {
  const marker = process.env[MARKER_ENV]?.trim()
  if (marker) return { path: marker, destination: 'scratch-marker' }
  return { path: join(resolveDshHome(configuredDshHome(ctx)), ...RECEIPT_SEGMENTS), destination: 'dsh-home' }
}

async function writeReceipt(path: string, receipt: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
}

function resolvedFilePath(resolved: string): string {
  return resolved.startsWith('file:') ? fileURLToPath(resolved) : resolved
}

async function installedRc2DependencyVersions(): Promise<Readonly<Record<string, string>>> {
  const packages = [
    '@deepseek-ai/dsh-agent-loop',
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-session-query',
    '@deepseek-ai/dsh-system-prompt',
    '@deepseek-ai/dsh-tools',
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

async function installedToolContext(): Promise<{ plugin: InstalledToolContextModule; evidence: InstalledPluginEvidence }> {
  const importPath = resolvedFilePath(import.meta.resolve(INSTALLED_PLUGIN))
  const source = await readFile(importPath)
  const plugin = await import(INSTALLED_PLUGIN) as InstalledToolContextModule
  assert(typeof plugin.apply === 'function', 'APP_PROBE_INSTALLED_PLUGIN_INVALID: installed tool-context has no apply()')
  assert(plugin.name === 'tool-context', 'APP_PROBE_INSTALLED_PLUGIN_INVALID: installed tool-context has an unexpected name')
  return {
    plugin,
    evidence: {
      importPath,
      libIndexSha256: createHash('sha256').update(source).digest('hex'),
      rc2Dependencies: await installedRc2DependencyVersions(),
    },
  }
}

function runCodeResponse(call: string, binding: string, args: object) {
  return toolCallResponse(call, 'run_code', {
    code: `return await tools.${binding}(${JSON.stringify(args)})`,
    description: `Probe invokes ${binding} through the published PTC transport.`,
  })
}

async function runIsolatedAcceptance(signal: AbortSignal, catalog: CatalogSnapshot): Promise<UnknownRecord> {
  const harness = await mountRequestHarness([
    runCodeResponse('probe-search', 'solar_tool_search', { query: TARGET_TOOL }),
    runCodeResponse('probe-load', 'solar_tool_load', { names: [TARGET_TOOL] }),
    runCodeResponse('probe-execute', TARGET_TOOL, { value: 'only after its declaration loaded' }),
    textResponse('Tool-context isolated probe completed.'),
  ], {
    ptcActions: [
      { name: 'solar_tool_search', arguments: { query: TARGET_TOOL } },
      { name: 'solar_tool_load', arguments: { names: [TARGET_TOOL] } },
      { name: TARGET_TOOL, arguments: { value: 'only after its declaration loaded' } },
    ],
  })
  try {
    signal.throwIfAborted()
    // Reuse the installed caller-visible catalog as inert metadata, avoiding
    // the earlier fixture's single-tool catalog coverage gap.
    for (const entry of catalog.entries) {
      harness.ctx.tools.register({
        ...entry,
        output: { schema: entry.output, render: () => [] },
        async execute() { throw new Error('APP_PROBE_METADATA_ONLY: a real catalog tool must never execute') },
      })
    }
    // Reproduce the observed repeated-horizontal-space rewrite without
    // importing or patching that plugin. A changed quoted value must fail.
    harness.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembly = await next()
      return { ...assembly, sections: assembly.sections.map(section => section.name === 'tools:sdk' ? { ...section, text: section.text.replace(/[ \t]{2,}/g, ' ').replace(/ \n/g, '\n').trim() } : section) }
    })
    harness.ctx.systemPrompt.section({ name: 'probe:standing-policy', text: 'PROBE_STANDING_POLICY_RETAINED', order: 0 })
    let businessCalls = 0
    harness.ctx.tools.register(defineTool({
      name: TARGET_TOOL,
      description: TARGET_MARKER,
      parameters: { value: { type: 'string', required: true } },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean', required: true } },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute() {
        businessCalls += 1
        return { ok: true }
      },
    }))
    const installed = await installedToolContext()
    await harness.ctx.plugin(installed.plugin)
    const agent = await createLoopAgent(harness, 'tool-context-installed-probe')
    await followLoopAgent(agent, 'Exercise only the isolated keyless tool-context path.')
    signal.throwIfAborted()

    const requests = harness.adapter.requests
    assert(requests.length === 4, `APP_PROBE_FAKE_PLAN_MISMATCH: expected 4 fake requests, got ${requests.length}`)
    assert(requests.every(request => request.tools?.map(tool => tool.name).join(',') === 'run_code'), 'APP_PROBE_PTC_SURFACE: a request exposed a direct tool schema')
    assert(Buffer.byteLength(systemText(requests[0]!), 'utf8') <= 8_192, 'APP_PROBE_BOOTSTRAP_TOO_LARGE: bootstrap exceeds 8192 bytes')
    assert(requests.every(request => systemText(request).includes('PROBE_STANDING_POLICY_RETAINED')), 'APP_PROBE_STANDING_POLICY_MISSING: a non-SDK policy disappeared')
    assert(!systemText(requests[0]!).includes(TARGET_MARKER), 'APP_PROBE_BOOTSTRAP_LEAK: business schema appeared before loading')
    assert(systemText(requests[2]!).includes(TARGET_MARKER), 'APP_PROBE_SELECTED_SCHEMA_MISSING: loaded schema did not reach the next request')
    assert(businessCalls === 1, `APP_PROBE_BUSINESS_CALL_COUNT: expected one body call, got ${businessCalls}`)
    assert(harness.ptc.bindingCalls.map(call => call.name).join(',') === `solar_tool_search,solar_tool_load,${TARGET_TOOL}`,
      'APP_PROBE_PTC_BINDINGS: unexpected PTC binding dispatch sequence')

    const events = agent.agent.session.snapshotEvents() as readonly { type: string; data: any }[]
    const names = events.filter(event => event.type === 'tool/ptc-dispatch').map(event => event.data.name)
    assert(names.join(',') === `solar_tool_search,solar_tool_load,${TARGET_TOOL}`, 'APP_PROBE_PTC_LOG: durable PTC dispatch log is incomplete')

    return {
      installedPlugin: {
        importPath: installed.evidence.importPath,
        libIndexSha256: installed.evidence.libIndexSha256,
        rc2Dependencies: installed.evidence.rc2Dependencies,
        exports: { apply: true, name: installed.plugin.name },
      },
      fakeModelCalls: requests.length,
      indentationRewrite: true,
      nonSdkPromptPreserved: true,
      catalogScope: catalog.scope,
      metadataOnlyToolCount: catalog.entries.length,
      fullCatalogSdkBytes: Buffer.byteLength(renderToolsSdk([...catalog.entries]), 'utf8'),
      ptcBindings: harness.ptc.bindingCalls.map(call => call.name),
      isolatedSessionEventCount: events.length,
      flushCount: harness.flushes.count,
      businessCalls,
    }
  } finally {
    await harness.cleanup()
  }
}

async function withDeadline<T>(parent: AbortSignal, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const abortFromParent = () => controller.abort(parent.reason)
  if (parent.aborted) abortFromParent()
  else parent.addEventListener('abort', abortFromParent, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  const operation = Promise.resolve().then(() => action(controller.signal))
  operation.catch(() => undefined)
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
    host = verifyHostTools(ctx)
    target = receiptPath(ctx)
    checks = await withDeadline(lifecycleSignal, async signal => runIsolatedAcceptance(signal, await hostCatalog(ctx)))
  } catch (error) {
    failure = serialiseError(error)
    try {
      target ??= receiptPath(ctx)
    } catch (pathError) {
      failure = { ...failure, message: `${failure.message}; APP_PROBE_RECEIPT_PATH_FAILED: ${serialiseError(pathError).message}` }
    }
  }

  let receipt: UnknownRecord = {
    formatVersion: 1,
    kind: 'solar-tool-context-app-keyless-acceptance',
    keyless: true,
    isolated: true,
    userSessionWrites: 0,
    realProviderCalls: 0,
    startedAt,
    finishedAt: new Date().toISOString(),
    ...(host === undefined ? {} : { host }),
    checks,
    ok: failure === undefined,
    ...(failure === undefined ? {} : { error: failure }),
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
  if (process.env[EXIT_ENV] === '1' && target?.destination === 'scratch-marker') {
    process.exit(receipt.ok === true ? 0 : 1)
  }
}

export const name = 'solar-tool-context-probe'
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
      process.stdout.write(`${JSON.stringify({
        formatVersion: 1,
        kind: 'solar-tool-context-app-keyless-acceptance',
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
    lifecycle?.abort(new Error('APP_PROBE_LIFECYCLE_CANCELLED: probe disposed before acceptance completed'))
  }
}
