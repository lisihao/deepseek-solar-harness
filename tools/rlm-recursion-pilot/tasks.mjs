import { createHash } from 'node:crypto'

const LABELS = Object.freeze(['entailment', 'contradiction', 'neutral'])
const LABEL_SET = new Set(LABELS)
const USER_COUNT = 32
const USER_WIDTH = 2
const FORMAT_VERSION = 1
const DATASET = 'oolongbench/oolong-synth'
const REVISION = '81d2f8d9349f6ff329d695f9be494051e9f05cb9'

const RECORD_LINE = /^Date:\s*(.*?)\s*\|\|\s*User:\s*([^|]+?)\s*\|\|\s*Instance:\s*(.*)$/
const LABEL_SUFFIX = /\s*\|\|\s*Label:\s*(entailment|contradiction|neutral)\s*$/

const TASK_DEFINITIONS = Object.freeze([
  { kind: 'q02', suffix: 'q02', name: 'semantic-label-counts' },
  { kind: 'q03', suffix: 'q03', name: 'user-pair-constraints' },
])

function fail(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  throw error
}

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function publicUser(index) {
  return `u${String(index).padStart(USER_WIDTH, '0')}`
}

function splitRecordLines(text) {
  if (typeof text !== 'string') fail('RLM_SOURCE_TEXT', 'source context must be a string')
  // OOLONG windows include a task/prompt header and footer around the records.
  // Only Date-prefixed lines are records; the corresponding labelled window is
  // aligned on exactly this same sequence below.
  return text.split(/\r?\n/).filter(line => line.startsWith('Date:'))
}

function parseRecordBody(line, sourceKind) {
  const match = RECORD_LINE.exec(line)
  if (!match) fail('RLM_SOURCE_RECORD', `cannot parse ${sourceKind} record line`)
  const date = match[1].trim()
  const originalUser = match[2].trim()
  const instance = match[3].trimEnd()
  const separator = instance.indexOf(' -> ')
  if (separator < 0) fail('RLM_SOURCE_INSTANCE', `record in ${sourceKind} text has no " -> " separator`)
  const premise = instance.slice(0, separator).trim()
  const hypothesis = instance.slice(separator + 4).trim()
  if (!premise || !hypothesis) fail('RLM_SOURCE_INSTANCE', `record in ${sourceKind} text has an empty sentence`)
  return {
    date,
    originalUser,
    premise,
    hypothesis,
    text: `${premise} -> ${hypothesis}`,
  }
}

function parseRawLine(line) {
  return parseRecordBody(line, 'unlabelled')
}

function parseLabelledLine(line) {
  const suffix = LABEL_SUFFIX.exec(line)
  if (!suffix) fail('RLM_SOURCE_LABEL', 'labelled record line has no valid private label suffix')
  // The source has a small number of whitespace-only differences before the
  // label suffix. They are not semantic differences and are removed by
  // trimEnd() before the one-to-one comparison.
  const body = line.slice(0, suffix.index).trimEnd()
  const parsed = parseRecordBody(body, 'labelled')
  return { ...parsed, label: suffix[1] }
}

function parseOfficialNumericAnswer(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === 'number' && Number.isInteger(value[0])) return value[0]
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return parseOfficialNumericAnswer(parsed)
  } catch {
    return null
  }
}

function inferOfficialLabel(question) {
  if (typeof question !== 'string') return null
  const explicit = /label\s+['\"]?(entailment|contradiction|neutral)['\"]?/i.exec(question)
  if (explicit) return explicit[1].toLowerCase()
  const labels = [...question.matchAll(/\b(entailment|contradiction|neutral)\b/gi)].map(match => match[1].toLowerCase())
  const unique = [...new Set(labels)]
  return unique.length === 1 ? unique[0] : null
}

function sourceProvenance(row, sourceRowIndex) {
  const sourceFile = typeof row?._file === 'string' ? row._file : null
  const sourceFileSha256 = typeof row?._fileSha256 === 'string' ? row._fileSha256 : null
  return {
    dataset: DATASET,
    revision: REVISION,
    sourceRowIndex,
    rowId: row?.id ?? null,
    contextWindowId: row?.context_window_id ?? null,
    contextLength: row?.context_len ?? null,
    parquetFile: sourceFile,
    parquetSha256: sourceFileSha256,
    customQuery: true,
    officialPaperReproduction: false,
    note: 'Custom Q02/Q03 query; this task is not an official OOLONG paper reproduction.',
  }
}

function parseSourceRow(row, sourceRowIndex) {
  if (!row || typeof row !== 'object') fail('RLM_SOURCE_ROW', `source row ${sourceRowIndex} is not an object`)
  const rawLines = splitRecordLines(row.context_window_text)
  const labelledLines = splitRecordLines(row.context_window_text_with_labels)
  if (!rawLines.length) fail('RLM_SOURCE_RECORDS', `source row ${sourceRowIndex} has no record lines`)
  if (rawLines.length !== labelledLines.length) fail('RLM_SOURCE_ALIGNMENT', `source row ${sourceRowIndex} record counts differ`)

  const records = rawLines.map((rawLine, sourcePosition) => {
    const raw = parseRawLine(rawLine)
    const labelled = parseLabelledLine(labelledLines[sourcePosition])
    const labelledBody = labelledLines[sourcePosition].slice(0, LABEL_SUFFIX.exec(labelledLines[sourcePosition]).index).trimEnd()
    if (rawLine.trimEnd() !== labelledBody) {
      fail('RLM_SOURCE_ALIGNMENT', `source row ${sourceRowIndex} record ${sourcePosition} differs beyond the label suffix`)
    }
    if (raw.date !== labelled.date || raw.originalUser !== labelled.originalUser || raw.text !== labelled.text) {
      fail('RLM_SOURCE_ALIGNMENT', `source row ${sourceRowIndex} record ${sourcePosition} differs beyond the label suffix`)
    }
    if (!LABEL_SET.has(labelled.label)) fail('RLM_SOURCE_LABEL', `source row ${sourceRowIndex} record ${sourcePosition} has an unknown label`)
    return {
      sourcePosition,
      date: raw.date,
      originalUser: raw.originalUser,
      premise: raw.premise,
      hypothesis: raw.hypothesis,
      text: raw.text,
      label: labelled.label,
      rawLineSha256: sha256(rawLine),
      labelledLineSha256: sha256(labelledLines[sourcePosition]),
    }
  })

  const officialLabel = inferOfficialLabel(row.question)
  const officialNumericGold = parseOfficialNumericAnswer(row.answer)
  return {
    row,
    sourceRowIndex,
    records,
    official: {
      question: typeof row.question === 'string' ? row.question : null,
      answer: row.answer ?? null,
      answerType: row.answer_type ?? null,
      label: officialLabel,
      numeric: officialNumericGold,
    },
    provenance: sourceProvenance(row, sourceRowIndex),
  }
}

function countLabels(records) {
  const counts = { entailment: 0, contradiction: 0, neutral: 0 }
  for (const record of records) counts[record.label] += 1
  return counts
}

function countByUser(records) {
  const result = new Map()
  for (let index = 0; index < USER_COUNT; index += 1) {
    result.set(publicUser(index), { entailment: 0, contradiction: 0, neutral: 0 })
  }
  for (const record of records) {
    const bucket = result.get(record.user)
    if (!bucket) fail('RLM_PUBLIC_USER', `record ${record.id} has an unknown public user`)
    bucket[record.label] += 1
  }
  return result
}

function computePairs(records) {
  const byUser = countByUser(records)
  const users = [...byUser.keys()]
  const pairs = []
  for (let left = 0; left < users.length; left += 1) {
    for (let right = left + 1; right < users.length; right += 1) {
      const leftCounts = byUser.get(users[left])
      const rightCounts = byUser.get(users[right])
      if (
        Math.abs(leftCounts.entailment - rightCounts.entailment) <= 1 &&
        leftCounts.neutral === rightCounts.neutral &&
        leftCounts.contradiction + rightCounts.contradiction >= 3
      ) {
        pairs.push([users[left], users[right]])
      }
    }
  }
  return pairs
}

function pseudoShuffle(length, salt) {
  const permutation = Array.from({ length }, (_unused, index) => index)
  const seed = String(salt ?? '')
  for (let index = permutation.length - 1; index > 0; index -= 1) {
    const digest = createHash('sha256').update(`${seed}\u0000${index}`, 'utf8').digest()
    const random = digest.readUInt32BE(0)
    const swap = random % (index + 1)
    const value = permutation[index]
    permutation[index] = permutation[swap]
    permutation[swap] = value
  }
  return permutation
}

function buildRules(kind, recordCount) {
  const pairSection = kind === 'q03'
    ? [
        '',
        'For `pairs`, enumerate every unordered pair of distinct public users that satisfies all three conditions:',
        '1. The absolute difference between their entailment counts is at most 1.',
        '2. Their neutral counts are equal.',
        '3. The sum of their contradiction counts is at least 3.',
        'Write each pair as `["uNN", "uMM"]` with the lower user id first, and include no duplicate pair.',
      ].join('\n')
    : ''
  return [
    '# Fixed NLI task rules',
    '',
    `There are exactly ${recordCount} independent sentence pairs in \`inputs/records.jsonl\`.`,
    'Each record has a public id, a public user id, and a pair of claims separated by ` -> `.',
    '',
    'Classify the second claim relative to the first claim using exactly one of these labels:',
    '- `entailment`: the second claim must be true whenever the first claim is true.',
    '- `contradiction`: the two claims cannot both be true in the stated context.',
    '- `neutral`: the first claim does not establish the second and the claims do not conflict.',
    '',
    'Use the complete input. Do not guess or estimate aggregate values.',
    `Your final answer must be one JSON object in \`answer.json\` with \`labels\` containing exactly one item for every record id (${recordCount} items), with no missing or duplicate id.`,
    'Each label item has exactly the fields `id` and `label`.',
    'The `counts` object must have exactly the integer fields `entailment`, `contradiction`, and `neutral`.',
    pairSection,
    '',
    'You may choose any chunking or reasoning strategy, including persistent Python or native recursive calls when available. A successful split is not required, and no particular child decomposition is implied.',
    'Do not change model or thinking settings. The whole tree, including the root and all descendants, may make at most 14 model requests and has a 20-minute wall-clock limit. Finish by writing the complete JSON answer to `answer.json`.',
  ].filter(Boolean).join('\n') + '\n'
}

function buildInstruction(kind, recordCount) {
  const goal = kind === 'q03'
    ? 'Return all qualifying unordered public-user pairs in addition to the complete per-record labels and aggregate counts.'
    : 'Return the complete per-record labels and aggregate counts.'
  return [
    `Solve the fixed OOLONG MultiNLI task with ${recordCount} records from \`inputs/records.jsonl\`.`,
    'Read the definitions and output constraints in `inputs/rules.md`.',
    goal,
    'Your output schema is the JSON object described there; write it to `answer.json` and cover every record id exactly once.',
    'You may use any chunking or persistent Python/native recursion strategy. Do not assume a successful split or a correct child decomposition.',
    'Do not change model or thinking settings. The whole tree is limited to 14 model requests and 20 minutes.',
  ].join('\n')
}

function makeTask(parsed, definition, salt) {
  const permutation = pseudoShuffle(parsed.records.length, salt)
  const records = permutation.map((sourcePosition, shuffledPosition) => {
    const sourceRecord = parsed.records[sourcePosition]
    return {
      id: `r${String(shuffledPosition).padStart(4, '0')}`,
      user: publicUser(shuffledPosition % USER_COUNT),
      text: sourceRecord.text,
      label: sourceRecord.label,
      date: sourceRecord.date,
      originalUser: sourceRecord.originalUser,
      premise: sourceRecord.premise,
      hypothesis: sourceRecord.hypothesis,
      sourcePosition: sourceRecord.sourcePosition,
      rawLineSha256: sourceRecord.rawLineSha256,
      labelledLineSha256: sourceRecord.labelledLineSha256,
    }
  })

  const publicRecords = records.map(({ id, user, text }) => JSON.stringify({ id, user, text })).join('\n') + '\n'
  const rules = buildRules(definition.kind, records.length)
  const counts = countLabels(records)
  const pairs = computePairs(records)
  const provenance = {
    ...parsed.provenance,
    taskKind: definition.kind,
    source: {
      rowId: parsed.provenance.rowId,
      window: parsed.provenance.contextWindowId,
      rowIndex: parsed.sourceRowIndex,
    },
  }
  const privateGold = {
    formatVersion: FORMAT_VERSION,
    taskKind: definition.kind,
    source: {
      ...parsed.provenance,
      official: parsed.official,
    },
    official: parsed.official,
    records,
    counts,
    pairs,
  }
  const rowToken = parsed.provenance.contextWindowId ?? parsed.provenance.rowId ?? parsed.sourceRowIndex
  return {
    id: `oolong-multinli-${rowToken}-${definition.suffix}`,
    family: 'oolong-multinli',
    instruction: buildInstruction(definition.kind, records.length),
    inputFiles: {
      'inputs/records.jsonl': publicRecords,
      'inputs/rules.md': rules,
    },
    privateGold,
    provenance,
    recordCount: records.length,
  }
}

/**
 * Parse the frozen OOLONG rows and prepare the two fixed Q02/Q03 tasks.
 * This function is pure: it returns public input strings and a private oracle
 * and performs no file writes, provider calls, or network access.
 */
export function prepareTasks(sourceRows, { salt = '' } = {}) {
  if (!Array.isArray(sourceRows) || sourceRows.length !== TASK_DEFINITIONS.length) {
    fail('RLM_SOURCE_ROWS', `expected exactly ${TASK_DEFINITIONS.length} source rows`)
  }
  const parsed = sourceRows.map((row, index) => parseSourceRow(row, index))
  return TASK_DEFINITIONS.map((definition, index) => makeTask(parsed[index], definition, salt))
}

export { LABELS, USER_COUNT, DATASET, REVISION }

