import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const HOME = process.env.DSH_HOME ?? process.cwd()
const COUNTS = join(HOME, 'model-catalog-fixture-calls')

const SOURCES = {
  deepseek: {
    id: 'deepseek:deepseek-official',
    name: 'DeepSeek',
    provider: 'deepseek-official',
    menuVisible: true,
  },
  codex: {
    id: 'native:codex',
    name: 'Codex',
    provider: 'dsh-physical-operator',
    menuVisible: true,
  },
  claude: {
    id: 'native:claude-code',
    name: 'Claude Code',
    provider: 'dsh-physical-operator',
    menuVisible: false,
  },
  web: {
    id: 'web:chatgpt-web',
    name: 'ChatGPT Web',
    provider: 'dsh-physical-operator',
    menuVisible: true,
  },
}

const effort = {
  efforts: [
    { id: 'low', name: 'Low' },
    { id: 'high', name: 'High' },
  ],
  defaultEffort: 'low',
}

function model(id, name, source, modelId, featuredRank) {
  return {
    id,
    name,
    provider: source.provider,
    model: modelId,
    availability: 'available',
    evidence: source.id.startsWith('deepseek:') ? 'api-list'
      : source.id.startsWith('native:') ? 'native-list' : 'web-picker',
    ...(featuredRank === undefined ? {} : { featuredRank }),
    ...(source.id === SOURCES.deepseek.id || source.id === SOURCES.codex.id
      ? { reasoning: effort }
      : {}),
  }
}

function modelsFor(source, phase) {
  switch (source.id) {
    case SOURCES.deepseek.id:
      return phase === 1
        ? [
          model('deepseek-v4-pro', 'Fixture DeepSeek Pro', source, 'deepseek-v4-pro', 0),
          model('deepseek-v4-flash', 'Fixture DeepSeek Flash', source, 'deepseek-v4-flash', 1),
          model('deepseek-v3-legacy', 'Fixture DeepSeek Legacy', source, 'deepseek-v3-legacy'),
          model('deepseek-v4-vision', 'Fixture DeepSeek Vision', source, 'deepseek-v4-vision'),
        ]
        : [
          model('deepseek-v4-flash', 'Fixture DeepSeek Flash', source, 'deepseek-v4-flash', 1),
          model('deepseek-v4-next', 'Fixture DeepSeek Next', source, 'deepseek-v4-next', 0),
          model('deepseek-v3-legacy', 'Fixture DeepSeek Legacy', source, 'deepseek-v3-legacy'),
        ]
    case SOURCES.codex.id:
      return [
        model('codex:gpt-6-astra', 'Fixture Codex Astra', source, 'codex:gpt-6-astra', 0),
        model('codex:gpt-6-sol', 'Fixture Codex Sol', source, 'codex:gpt-6-sol', 1),
        model('codex:gpt-5.6-luna', 'Fixture Codex Luna', source, 'codex:gpt-5.6-luna'),
        model('codex:gpt-5.6-terra', 'Fixture Codex Terra', source, 'codex:gpt-5.6-terra'),
      ]
    case SOURCES.claude.id:
      return [
        model('claude-code:claude-fable-5', 'Fixture Claude Fable', source, 'claude-code:claude-fable-5', 0),
        model('claude-code:claude-sonnet-5', 'Fixture Claude Sonnet', source, 'claude-code:claude-sonnet-5', 1),
        model('claude-code:claude-opus-5', 'Fixture Claude Opus', source, 'claude-code:claude-opus-5'),
      ]
    case SOURCES.web.id:
      return [
        model('chatgpt-web:fixture-pro', 'Fixture ChatGPT Pro', source, 'chatgpt-web:fixture-pro', 0),
        model('chatgpt-web:fixture-thinking', 'Fixture ChatGPT Thinking', source, 'chatgpt-web:fixture-thinking', 1),
        model('chatgpt-web:fixture-fast', 'Fixture ChatGPT Fast', source, 'chatgpt-web:fixture-fast'),
      ]
    default:
      throw new Error(`model-catalog-fixture: unknown source ${source.id}`)
  }
}

function countFile(source) {
  return join(COUNTS, source.id.replaceAll(':', '-'))
}

async function nextPhase(source) {
  await mkdir(COUNTS, { recursive: true })
  const path = countFile(source)
  const previous = Number.parseInt(await readFile(path, 'utf8').catch(() => '0'), 10)
  const phase = Number.isFinite(previous) ? previous + 1 : 1
  await writeFile(path, `${phase}\n`)
  return phase
}

function source(source) {
  return {
    ...source,
    async refresh(signal) {
      if (signal.aborted) throw signal.reason ?? new Error('model-catalog-fixture: refresh aborted')
      const phase = await nextPhase(source)
      if (source.id === SOURCES.web.id && phase >= 2) {
        throw new Error('fixture ChatGPT Web discovery failed')
      }
      return { available: true, models: modelsFor(source, phase) }
    },
  }
}

const physicalModels = [
  ...modelsFor(SOURCES.codex, 1),
  ...modelsFor(SOURCES.claude, 1),
  ...modelsFor(SOURCES.web, 1),
]

const physicalAdapter = {
  providerInfo(provider) {
    return { id: provider, name: '物理算子' }
  },
  providerRetryPolicy() {
    return undefined
  },
  listModels(provider) {
    return Promise.resolve(physicalModels.map(entry => ({
      provider,
      id: entry.model,
      name: entry.name,
      description: 'Keyless assembled catalog fixture.',
    })))
  },
  resolveModel(provider, id) {
    const entry = physicalModels.find(item => item.model === id)
    return Promise.resolve({ provider, id, name: entry?.name ?? id })
  },
  async *stream() {
    throw new Error('model-catalog-fixture: model calls are out of scope')
  },
}

export const name = 'model-catalog-fixtures'
export const inject = ['llm', 'modelCatalogs']

export function apply(ctx) {
  const adapter = ctx.llm.registerAdapter(['dsh-physical-operator'], physicalAdapter)
  ctx.effect(() => adapter, 'model-catalog-fixture: physical route')
  for (const entry of Object.values(SOURCES)) {
    const dispose = ctx.modelCatalogs.register(source(entry))
    ctx.effect(() => dispose, `model-catalog-fixture: ${entry.id}`)
  }
}
