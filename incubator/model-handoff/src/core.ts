export interface HandoffQuestion {
  readonly id: string
  readonly question: string
}

export interface HandoffDraft {
  readonly summary: string
  readonly questions: readonly HandoffQuestion[]
}

export interface HandoffAnswer {
  readonly id: string
  readonly answer: string
}

export interface HandoffTarget {
  readonly provider: string
  readonly model: string
}

export type HandoffErrorCode =
  | 'invalid-input'
  | 'code-fence'
  | 'invalid-json'
  | 'invalid-shape'
  | 'unexpected-field'
  | 'invalid-string'
  | 'empty-string'
  | 'length-exceeded'
  | 'question-count'
  | 'duplicate-id'
  | 'answer-mismatch'

export class HandoffError extends Error {
  readonly code: HandoffErrorCode

  constructor(code: HandoffErrorCode, message: string) {
    super(message)
    this.name = 'HandoffError'
    this.code = code
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

const DRAFT_KEYS = ['summary', 'questions'] as const
const QUESTION_KEYS = ['id', 'question'] as const
const ANSWER_KEYS = ['id', 'answer'] as const
const TARGET_KEYS = ['provider', 'model'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === expected.length && expected.every((key) => actual.includes(key))
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  if (!sameKeys(value, expected)) {
    const unexpected = Object.keys(value).filter((key) => !expected.includes(key))
    if (unexpected.length > 0) {
      throw new HandoffError(
        'unexpected-field',
        `${label} contains unsupported field "${unexpected[0]}"`,
      )
    }
    throw new HandoffError('invalid-shape', `${label} must contain exactly ${expected.join(' and ')}`)
  }
}

function characterCount(value: string): number {
  return Array.from(value).length
}

function requireBoundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string') {
    throw new HandoffError('invalid-string', `${label} must be a string`)
  }
  if (value.length === 0 || value.trim().length === 0) {
    throw new HandoffError('empty-string', `${label} must not be empty`)
  }
  if (characterCount(value) > maximum) {
    throw new HandoffError('length-exceeded', `${label} must be at most ${maximum} characters`)
  }
  return value
}

function validateDraft(value: unknown): HandoffDraft {
  if (!isRecord(value)) {
    throw new HandoffError('invalid-shape', 'draft must be a JSON object')
  }
  requireExactKeys(value, DRAFT_KEYS, 'draft')
  const summary = requireBoundedText(value.summary, 'summary', 50_000)
  if (!Array.isArray(value.questions)) {
    throw new HandoffError('invalid-shape', 'questions must be an array')
  }
  if (value.questions.length < 2 || value.questions.length > 3) {
    throw new HandoffError('question-count', 'questions must contain 2 or 3 items')
  }

  const questions: HandoffQuestion[] = []
  const ids = new Set<string>()
  for (const [index, item] of value.questions.entries()) {
    const label = `questions[${index}]`
    if (!isRecord(item)) {
      throw new HandoffError('invalid-shape', `${label} must be an object`)
    }
    requireExactKeys(item, QUESTION_KEYS, label)
    const id = requireBoundedText(item.id, `${label}.id`, 64)
    if (ids.has(id)) {
      throw new HandoffError('duplicate-id', `questions contains duplicate id "${id}"`)
    }
    ids.add(id)
    const question = requireBoundedText(item.question, `${label}.question`, 1_000)
    questions.push({ id, question })
  }
  return { summary, questions }
}

/** Parse the model's handoff draft without coercing or normalizing its text. */
export function parseDraft(text: string): HandoffDraft {
  if (typeof text !== 'string') {
    throw new HandoffError('invalid-input', 'draft text must be a string')
  }
  if (text.trimStart().startsWith('```')) {
    throw new HandoffError('code-fence', 'draft must not contain a Markdown code fence')
  }

  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    throw new HandoffError('invalid-json', 'draft is not valid JSON')
  }
  return validateDraft(value)
}

function validateAnswer(value: unknown, index: number): HandoffAnswer {
  const label = `answers[${index}]`
  if (!isRecord(value)) {
    throw new HandoffError('invalid-shape', `${label} must be an object`)
  }
  requireExactKeys(value, ANSWER_KEYS, label)
  const id = requireBoundedText(value.id, `${label}.id`, 64)
  const answer = requireBoundedText(value.answer, `${label}.answer`, 10_000)
  return { id, answer }
}

function validateTarget(value: unknown): HandoffTarget {
  if (!isRecord(value)) {
    throw new HandoffError('invalid-shape', 'target must be an object')
  }
  requireExactKeys(value, TARGET_KEYS, 'target')
  return {
    provider: requireBoundedText(value.provider, 'target.provider', Number.MAX_SAFE_INTEGER),
    model: requireBoundedText(value.model, 'target.model', Number.MAX_SAFE_INTEGER),
  }
}

/**
 * Render a deterministic, self-contained handoff for the selected target.
 * Answers are emitted byte-for-byte as supplied, including surrounding spaces.
 */
export function renderHandoff(
  draft: HandoffDraft,
  answers: readonly HandoffAnswer[],
  target: HandoffTarget,
): string {
  const validatedDraft = validateDraft(draft)
  if (!Array.isArray(answers)) {
    throw new HandoffError('invalid-input', 'answers must be an array')
  }
  const validatedTarget = validateTarget(target)
  if (answers.length !== validatedDraft.questions.length) {
    throw new HandoffError('answer-mismatch', 'answers must contain exactly one answer for every question')
  }

  const validatedAnswers: HandoffAnswer[] = []
  const expectedIds = new Set(validatedDraft.questions.map(({ id }) => id))
  const seenIds = new Set<string>()
  for (const [index, value] of answers.entries()) {
    const answer = validateAnswer(value, index)
    if (!expectedIds.has(answer.id) || seenIds.has(answer.id)) {
      throw new HandoffError('answer-mismatch', `answers contains an unexpected or duplicate id "${answer.id}"`)
    }
    seenIds.add(answer.id)
    validatedAnswers.push(answer)
  }
  if (seenIds.size !== expectedIds.size) {
    throw new HandoffError('answer-mismatch', 'answers is missing one or more question ids')
  }

  const answerById = new Map(validatedAnswers.map((answer) => [answer.id, answer.answer]))
  const lines = [
    '模型交接',
    `目标提供方：${validatedTarget.provider}`,
    `目标模型：${validatedTarget.model}`,
    '摘要：',
    validatedDraft.summary,
  ]
  validatedDraft.questions.forEach((question, index) => {
    lines.push(
      `问题${index + 1}：${question.question}`,
      `回答${index + 1}：${answerById.get(question.id) as string}`,
    )
  })
  return lines.join('\n')
}
