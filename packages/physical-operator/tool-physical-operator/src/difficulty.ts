/**
 * A coarse, explainable judgment of how hard a delegated request is, used to decide how much of the
 * strongest model's cost the request deserves. It reads the message text and nothing else, so the
 * same message always gets the same answer; a failed or repeated attempt raises it one step.
 * @module @deepseek-ai/dsh-tool-physical-operator/difficulty
 */

/** How demanding a request looks. */
export type Difficulty = 'easy' | 'normal' | 'hard'

const LADDER: readonly Difficulty[] = ['easy', 'normal', 'hard']

const HARD = new RegExp([
  '架构|重构|跨(?:模块|仓库|服务|学科)|迁移|并发(?!布)|竞态|死锁|内存泄漏|性能(?:优化|瓶颈|回退)|安全(?:漏洞|审计|加固)',
  '设计(?:方案|文档)|从零|整个(?:项目|仓库|代码库)|端到端|全面|系统性',
  'refactor|architecture|migrat(?:e|ion)|concurren|race condition|deadlock|memory leak|security (?:audit|hole|vulnerab)',
  'performance (?:regression|bottleneck)|end-to-end|from scratch|entire (?:repo|codebase|project)|system(?:-|\\s)wide',
].join('|'), 'iu')

const EASY = new RegExp([
  '改名|重命名|注释|格式化|拼写|错别字|一行|简单|解释|什么意思|怎么用|版本号|日志',
  'rename|comment|format|lint|spell|typo|one[- ]line|trivial|simple|explain|what does|how do i|bump|log message',
].join('|'), 'iu')

const RETRY = /重试|再试|再来|不对|还是不行|没解决|没有解决|仍然|依然|try again|retry|still (?:wrong|broken|fails?|not)|doesn'?t work|didn'?t work/iu

const LONG_REQUEST = 1_200
const SHORT_REQUEST = 200

function hasStackTrace(text: string): boolean {
  return /Traceback \(most recent call last\)/u.test(text) || (text.match(/^\s*at\s+\S+.*[:(]\d+/gmu) ?? []).length >= 3
}

function codeBlocks(text: string): number {
  return Math.floor((text.match(/```/gu) ?? []).length / 2)
}

/**
 * Judge a request from its text.
 * @param text - the user's request.
 * @returns `hard` for architecture-scale or long, code-heavy work; `easy` for short, simple edits and
 * questions; otherwise `normal`.
 */
export function classifyDifficulty(text: string): Difficulty {
  const value = text.trim()
  if (HARD.test(value) || value.length > LONG_REQUEST || hasStackTrace(value) || codeBlocks(value) >= 3) return 'hard'
  if (value.length <= SHORT_REQUEST && EASY.test(value)) return 'easy'
  return 'normal'
}

/**
 * Whether a message asks to try the previous request again.
 * @param text - the user's message.
 * @returns true for retry or complaint phrasing such as "重试", "不对", or "try again".
 */
export function isRetryRequest(text: string): boolean {
  return RETRY.test(text)
}

/**
 * Raise a difficulty by a number of steps, stopping at `hard`.
 * @param level - the starting difficulty.
 * @param steps - how many steps to raise it; zero or less keeps it.
 * @returns the raised difficulty.
 */
export function escalate(level: Difficulty, steps: number): Difficulty {
  return LADDER[Math.min(LADDER.length - 1, LADDER.indexOf(level) + Math.max(0, steps))] as Difficulty
}

/** The facts about the conversation that raise a request's difficulty. */
export interface DifficultyContext {
  /** The earlier user messages of this session, newest first, without the current one. */
  readonly earlierRequests: readonly string[]
  /** Whether the latest delegated run ended in a failure rather than an answer. */
  readonly lastDispatchFailed: boolean
}

/**
 * Judge the current request together with what happened before it.
 * A retry message takes the difficulty of the request it repeats, and a failed earlier delegation raises it
 * one step further; each of the two raises it one step, so a repeated failure reaches `hard` quickly.
 * @param text - the current user message.
 * @param context - earlier requests and whether the last delegation failed.
 * @returns the difficulty and how many steps it was raised.
 */
export function judgeDifficulty(text: string, context: DifficultyContext): { readonly level: Difficulty; readonly raised: number } {
  const retry = isRetryRequest(text)
  const basis = retry ? context.earlierRequests.find(earlier => !isRetryRequest(earlier)) ?? text : text
  const raised = (retry ? 1 : 0) + (context.lastDispatchFailed ? 1 : 0)
  return { level: escalate(classifyDifficulty(basis), raised), raised }
}
