/**
 * Live roster of the user's Gouzi for the kennel preset.
 *
 * The persona says how the steward works; this adds who is in the kennel right now, read from the orchestration
 * service on every assembly, so a dog adopted or retired in Settings shows up on the next request.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'kennel-context'

/** The prompt registry whose assembly this plugin extends. */
export const inject = ['systemPrompt']

/** Provider ids a dog can advertise, in the order the steward should prefer them. */
const PROVIDERS = [
  ['codex', 'Codex'],
  ['claude-code', 'Claude Code，对方已登录时才可用'],
]

const ACTIVITY = {
  resting: '休息中',
  queued: '排队中',
  working: '工作中',
  'awaiting-approval': '等你批准',
  paused: '已暂停',
  faulted: '出错了',
}

/**
 * Render the roster the steward reads.
 * @param listing - `GouziControl.list()` result, or undefined when the orchestration service is unavailable.
 * @returns the text of the `kennel:roster` context.
 */
export function renderRoster(listing) {
  if (listing === undefined) {
    return '## 狗窝\n\n现在读不到狗子名单（编排服务不可用）。不要给狗子派活，直接告诉用户。'
  }
  const hosts = new Map(listing.hosts.map(host => [String(host.hostId), host.label]))
  const dogs = listing.members.filter(member => member.membership === 'enabled')
  if (dogs.length === 0) {
    return '## 狗窝\n\n现在一只狗子都没有。请用户到 设置 → 狗子 领养一只，再回来。'
  }
  const lines = dogs.map((dog) => {
    const id = String(dog.gouziId)
    const where = hosts.get(String(dog.hostId)) ?? String(dog.hostId)
    const reach = dog.connection === 'online' ? '在线' : '联系不上'
    const doing = ACTIVITY[dog.activity] ?? dog.activity
    const operators = PROVIDERS.map(([provider, note]) => `\`gouzi.${id}.${provider}\`（${note}）`).join('、')
    return `- ${dog.name}｜${dog.role}｜住在 ${where}｜${reach}｜${doing}\n  operator id：${operators}`
  })
  return [
    '## 狗窝',
    '',
    `现在有 ${String(dogs.length)} 只启用的狗子（名单来自 设置 → 狗子）。派活时把对应 id 填进节点的 operator.preferredIds；联系不上的不要派：`,
    '',
    ...lines,
  ].join('\n')
}

/** Read the roster, or undefined when it cannot be read. */
async function readRoster(ctx) {
  try {
    return await ctx.get('orchestrations')?.gouzi?.list()
  } catch {
    // The steward is told the roster is unavailable instead of failing the whole request.
    return undefined
  }
}

/**
 * Append the roster to every prompt assembly of the sessions this preset composes.
 * @param ctx - preset plugin context.
 */
export function apply(ctx) {
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    const text = renderRoster(await readRoster(ctx))
    return { ...assembled, contexts: [...(assembled.contexts ?? []), { name: 'kennel:roster', text }] }
  })
}
