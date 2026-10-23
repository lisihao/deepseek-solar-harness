import { join } from 'node:path'

const FAKE_SKILL_NAME = 'solar-probe-skill'
const FAKE_SKILL_CONTENT = 'Use this fixture skill only to prove that the official loader still loads complete bodies.'
const INCOMPLETE_PROVIDER_NAME = 'solar-skill-context-probe-incomplete'

function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`skill-context probe requires ${name}`)
  return value
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function serialiseError(error) {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack }
  return { name: 'UnknownError', message: String(error) }
}

function resultError(result) {
  return result?.isError === true ? `${result.error?.info?.code ?? 'TOOL_ERROR'}: ${result.error?.message ?? 'unknown tool error'}` : undefined
}

function successValue(result, label) {
  const failure = resultError(result)
  if (failure !== undefined) throw new Error(`${label} failed: ${failure}`)
  assert(result?.isError === false, `${label} did not return a successful tool result`)
  return result.value
}

function toolCall(tools, name, argumentsValue, callId) {
  return tools.execute({
    callId,
    name,
    arguments: argumentsValue,
    signal: new AbortController().signal,
  })
}

async function exerciseBoundedSearch(skills, tools) {
  const schemas = tools.schemas()
  const names = new Set(schemas.map((schema) => schema.name))
  assert(names.has('solar_skill_search'), 'solar_skill_search is not present in the public tool schema')
  assert(names.has('skill'), 'the official skill loader is not present in the public tool schema')

  const search = successValue(
    await toolCall(tools, 'solar_skill_search', { query: 'probe-skill' }, 'skill-context-probe-search'),
    'solar_skill_search',
  )
  assert(Array.isArray(search?.matches), 'solar_skill_search returned no matches array')
  assert(search.matches.some((match) => match.name === FAKE_SKILL_NAME), 'solar_skill_search did not find the fixture skill')
  assert(search.matches.length <= 8, `solar_skill_search returned more than the default page size: ${search.matches.length}`)
  assert(search.totalMatches >= 33, `solar_skill_search did not observe the complete fixture snapshot: ${String(search.totalMatches)}`)
  assert(search.nextOffset !== undefined, 'solar_skill_search omitted nextOffset for a broad fixture match')
  for (const match of search.matches) {
    assert(Array.from(match.description).length <= 240, 'solar_skill_search exceeded its default description character limit')
  }
  assert(Buffer.byteLength(JSON.stringify(search), 'utf8') <= 8_192, 'solar_skill_search exceeded the default UTF-8 response limit')

  const loaded = successValue(
    await toolCall(tools, 'skill', { name: FAKE_SKILL_NAME }, 'skill-context-probe-load-before-dispose'),
    'official skill loader',
  )
  assert(loaded?.name === FAKE_SKILL_NAME, 'official skill loader returned the wrong skill name')
  assert(loaded?.content === FAKE_SKILL_CONTENT, 'official skill loader did not return the fixture skill body')

  const disposeIncomplete = skills.registerProvider(() => ({
    name: INCOMPLETE_PROVIDER_NAME,
    async list() {
      return { candidates: [], complete: false }
    },
    async get() {
      return undefined
    },
  }))
  let incompleteError
  try {
    const incomplete = await toolCall(tools, 'solar_skill_search', { query: 'probe-skill' }, 'skill-context-probe-incomplete')
    incompleteError = resultError(incomplete)
  } finally {
    disposeIncomplete()
  }
  assert(incompleteError?.includes('SKILL_CONTEXT_SNAPSHOT_INCOMPLETE'), `incomplete snapshot did not fail with the named error: ${String(incompleteError)}`)

  return {
    searchMatches: search.matches,
    searchBytes: Buffer.byteLength(JSON.stringify(search), 'utf8'),
    loadedSkill: loaded.name,
    incompleteError,
    totalMatches: search.totalMatches,
    nextOffset: search.nextOffset,
  }
}

async function disposeSkillContext(ctx, tools) {
  const runtimes = [...ctx.registry.values()].filter((runtime) => runtime.name === 'skill-context')
  assert(runtimes.length > 0, 'skill-context runtime is not registered')
  const fibers = runtimes.flatMap((runtime) => [...runtime.fibers])
  assert(fibers.length > 0, 'skill-context has no active plugin fiber')
  for (const fiber of fibers) await fiber.dispose()

  const remainingNames = new Set(tools.schemas().map((schema) => schema.name))
  assert(!remainingNames.has('solar_skill_search'), 'skill-context disposal left solar_skill_search registered')
  assert(remainingNames.has('skill'), 'skill-context disposal removed the official skill loader')
  for (const fiber of fibers) assert(fiber.getEffects().length === 0, 'skill-context disposal left an event/tool effect behind')
  return { disposedFibers: fibers.length, remainingTools: [...remainingNames].filter((name) => name === 'skill') }
}

async function writeMarker(markerPath, marker) {
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(join(markerPath, '..'), { recursive: true })
  await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
}

async function runProbe(ctx) {
  const markerPath = requiredEnv('SOLAR_SKILL_CONTEXT_PROBE_MARKER')
  const tools = ctx.get('tools')
  const skills = ctx.get('skills')
  assert(tools !== undefined, 'tools service is unavailable')
  assert(skills !== undefined, 'skills service is unavailable')

  const skillDisposers = Array.from({ length: 33 }, (_, index) => {
    const name = index === 0 ? FAKE_SKILL_NAME : `${FAKE_SKILL_NAME}-${String(index).padStart(2, '0')}`
    return skills.register({
      name,
      description: `A local fixture skill used to verify bounded search and official loading. ${name} `.repeat(32),
      content: index === 0 ? FAKE_SKILL_CONTENT : `Fixture skill body ${name}.`,
      source: 'runtime',
      invocation: { modelInvocable: true, userInvocable: true },
    })
  })
  ctx.effect(() => () => {
    for (const dispose of skillDisposers) dispose()
  })

  let checks = {}
  let error
  try {
    checks = await exerciseBoundedSearch(skills, tools)
    checks.lifecycle = await disposeSkillContext(ctx, tools)
  } catch (caught) {
    error = serialiseError(caught)
  }

  const marker = {
    formatVersion: 1,
    pid: process.pid,
    keyless: true,
    ok: error === undefined,
    checks,
    ...(error === undefined ? {} : { error }),
  }
  await writeMarker(markerPath, marker)
  const exit = ctx.get('appExit')
  if (typeof exit !== 'function') throw new Error('appExit service is unavailable after probe marker write')
  exit(error === undefined ? 0 : 1)
}

export const name = 'solar-skill-context-probe'
export const inject = ['appReady']

export function apply(ctx) {
  const ready = ctx.get('appReady')
  if (ready === undefined || typeof ready.onReady !== 'function') throw new Error('appReady service is unavailable')
  let started = false
  const cancel = ready.onReady(() => {
    if (started) return
    started = true
    void runProbe(ctx).catch(async (error) => {
      try {
        await writeMarker(requiredEnv('SOLAR_SKILL_CONTEXT_PROBE_MARKER'), {
          formatVersion: 1,
          pid: process.pid,
          keyless: true,
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
