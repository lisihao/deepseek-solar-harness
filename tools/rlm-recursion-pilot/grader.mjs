const LABELS = Object.freeze(['entailment', 'contradiction', 'neutral'])
const LABEL_SET = new Set(LABELS)
const USER_COUNT = 32
const USER_RE = /^u(?:[0-2]\d|3[01])$/

function ownKeys(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value)
    : []
}

function hasExactKeys(value, expected) {
  const keys = ownKeys(value).sort()
  const wanted = [...expected].sort()
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index])
}

function emptyCounts() {
  return { entailment: 0, contradiction: 0, neutral: 0 }
}

function isIntegerCount(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function equalCounts(left, right) {
  return LABELS.every(label => left?.[label] === right?.[label])
}

function pairKey(pair) {
  return `${pair[0]}\u0000${pair[1]}`
}

function canonicalPairs(pairs) {
  return [...pairs]
    .map(pair => [pair[0], pair[1]])
    .sort((left, right) => pairKey(left).localeCompare(pairKey(right)))
}

function equalPairSets(left, right) {
  if (left.length !== right.length) return false
  const expected = new Set(left.map(pairKey))
  const actual = new Set(right.map(pairKey))
  return expected.size === left.length && actual.size === right.length && right.every(pair => expected.has(pairKey(pair)))
}

function pairF1(expected, predicted) {
  const expectedSet = new Set(expected.map(pairKey))
  const predictedSet = new Set(predicted.map(pairKey))
  let truePositives = 0
  for (const key of predictedSet) if (expectedSet.has(key)) truePositives += 1
  if (expectedSet.size === 0 && predictedSet.size === 0) return 1
  if (expectedSet.size === 0 || predictedSet.size === 0) return 0
  const precision = truePositives / predictedSet.size
  const recall = truePositives / expectedSet.size
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
}

function knownUser(user) {
  return typeof user === 'string' && USER_RE.test(user)
}

function derivePairs(records) {
  const byUser = new Map()
  for (let index = 0; index < USER_COUNT; index += 1) {
    byUser.set(`u${String(index).padStart(2, '0')}`, emptyCounts())
  }
  for (const record of records) byUser.get(record.user)[record.label] += 1
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

function deriveExpected(task) {
  const privateGold = task?.privateGold
  if (!privateGold || !Array.isArray(privateGold.records)) {
    throw new Error('RLM_GOLD: task.privateGold.records must be an array')
  }
  const records = privateGold.records
  const ids = []
  const idSet = new Set()
  const labels = new Map()
  const counts = emptyCounts()
  for (const record of records) {
    if (!record || typeof record !== 'object') throw new Error('RLM_GOLD: record must be an object')
    if (typeof record.id !== 'string' || idSet.has(record.id)) throw new Error('RLM_GOLD: record ids must be unique strings')
    if (!knownUser(record.user)) throw new Error(`RLM_GOLD: unknown public user ${String(record.user)}`)
    if (!LABEL_SET.has(record.label)) throw new Error(`RLM_GOLD: unknown label ${String(record.label)}`)
    idSet.add(record.id)
    ids.push(record.id)
    labels.set(record.id, record.label)
    counts[record.label] += 1
  }
  return {
    records,
    ids,
    idSet,
    labels,
    counts,
    pairs: derivePairs(records),
    kind: privateGold.taskKind ?? task?.provenance?.taskKind ?? null,
  }
}

function coverageForLabels(labels, expected) {
  const duplicateIds = []
  const unexpectedIds = []
  const invalidIds = []
  const invalidLabels = []
  const seen = new Set()
  let validLabelCount = 0
  if (Array.isArray(labels)) {
    for (const item of labels) {
      const id = item && typeof item === 'object' && !Array.isArray(item) ? item.id : undefined
      const label = item && typeof item === 'object' && !Array.isArray(item) ? item.label : undefined
      if (typeof id !== 'string') {
        invalidIds.push(id)
        continue
      }
      if (!expected.idSet.has(id)) unexpectedIds.push(id)
      if (seen.has(id)) duplicateIds.push(id)
      seen.add(id)
      if (!LABEL_SET.has(label)) invalidLabels.push({ id, label })
      if (expected.idSet.has(id) && LABEL_SET.has(label) && !duplicateIds.includes(id)) validLabelCount += 1
    }
  }
  const missingIds = expected.ids.filter(id => !seen.has(id))
  return {
    expectedCount: expected.ids.length,
    providedCount: Array.isArray(labels) ? labels.length : 0,
    validLabelCount,
    missingIds,
    duplicateIds: [...new Set(duplicateIds)],
    unexpectedIds: [...new Set(unexpectedIds)],
    invalidIds,
    invalidLabels,
    completeUnique: missingIds.length === 0 && duplicateIds.length === 0 && unexpectedIds.length === 0 && invalidIds.length === 0 && invalidLabels.length === 0,
  }
}

function parseAnswer(answerText, expected) {
  const errors = []
  let value = null
  if (typeof answerText !== 'string') {
    errors.push('answer must be a JSON string')
  } else {
    try {
      value = JSON.parse(answerText)
    } catch (error) {
      errors.push(`invalid JSON: ${error.message}`)
    }
  }

  const taskKind = expected.kind
  const requiredRootKeys = taskKind === 'q03' ? ['labels', 'counts', 'pairs'] : ['labels', 'counts']
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    errors.push('answer root must be a JSON object')
  } else if (!hasExactKeys(value, requiredRootKeys)) {
    errors.push(`answer root must have exactly ${requiredRootKeys.join(', ')}`)
  }

  const labels = value && typeof value === 'object' && !Array.isArray(value) ? value.labels : null
  const coverage = coverageForLabels(labels, expected)
  if (!Array.isArray(labels)) {
    errors.push('labels must be an array')
  } else {
    for (const item of labels) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        errors.push('each labels item must be an object')
        continue
      }
      if (!hasExactKeys(item, ['id', 'label'])) errors.push('each labels item must have exactly id and label')
    }
    if (!coverage.completeUnique || coverage.providedCount !== expected.ids.length) {
      errors.push('labels must cover every expected id exactly once with a legal label')
    }
  }

  const counts = value && typeof value === 'object' && !Array.isArray(value) ? value.counts : null
  const countsValid = counts && hasExactKeys(counts, LABELS) && LABELS.every(label => isIntegerCount(counts[label]))
  if (!countsValid) errors.push('counts must contain exactly three non-negative integer label counts')

  let pairs = []
  let pairsValid = true
  if (taskKind === 'q03') {
    pairs = value && typeof value === 'object' && !Array.isArray(value) ? value.pairs : null
    if (!Array.isArray(pairs)) {
      pairsValid = false
      errors.push('pairs must be an array')
    } else {
      const seenPairs = new Set()
      for (const pair of pairs) {
        if (!Array.isArray(pair) || pair.length !== 2 || !knownUser(pair[0]) || !knownUser(pair[1])) {
          pairsValid = false
          errors.push('each pair must contain two known public users')
          continue
        }
        if (pair[0] >= pair[1]) {
          pairsValid = false
          errors.push('each pair must be in ascending user order')
        }
        const key = pairKey(pair)
        if (seenPairs.has(key)) {
          pairsValid = false
          errors.push('pairs must not contain duplicates')
        }
        seenPairs.add(key)
      }
    }
  }

  return {
    value,
    labels,
    counts,
    countsValid,
    pairs,
    pairsValid,
    coverage,
    errors: [...new Set(errors)],
    schemaValid: errors.length === 0,
  }
}

function predictedLabelMap(parsed, expected) {
  const result = new Map()
  if (!Array.isArray(parsed.labels)) return result
  for (const item of parsed.labels) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    if (typeof item.id !== 'string' || !expected.idSet.has(item.id) || !LABEL_SET.has(item.label) || result.has(item.id)) continue
    result.set(item.id, item.label)
  }
  return result
}

function countsFromLabels(labelMap, expected) {
  if (labelMap.size !== expected.ids.length) return null
  const counts = emptyCounts()
  for (const id of expected.ids) {
    const label = labelMap.get(id)
    if (!LABEL_SET.has(label)) return null
    counts[label] += 1
  }
  return counts
}

function pairsFromLabels(labelMap, expected) {
  if (labelMap.size !== expected.ids.length) return null
  const records = expected.records.map(record => ({ ...record, label: labelMap.get(record.id) }))
  return derivePairs(records)
}

function baseResult(expected, parsed, goldError = null) {
  const labelMap = expected && parsed ? predictedLabelMap(parsed, expected) : new Map()
  let correct = 0
  if (expected) {
    for (const id of expected.ids) if (labelMap.get(id) === expected.labels.get(id)) correct += 1
  }
  const labelAccuracy = expected && expected.ids.length > 0 ? correct / expected.ids.length : 0
  const countsExact = Boolean(expected && parsed?.countsValid && equalCounts(parsed.counts, expected.counts))
  let pairsExact = null
  let pairMetrics = null
  let selfConsistency = false
  if (expected?.kind === 'q03') {
    const predictedPairs = parsed?.pairsValid ? parsed.pairs : []
    pairsExact = Boolean(parsed?.pairsValid && equalPairSets(expected.pairs, predictedPairs))
    const f1 = parsed?.pairsValid ? pairF1(expected.pairs, predictedPairs) : 0
    const expectedSet = new Set(expected.pairs.map(pairKey))
    const predictedSet = new Set(predictedPairs.map(pairKey))
    let truePositives = 0
    for (const key of predictedSet) if (expectedSet.has(key)) truePositives += 1
    pairMetrics = {
      precision: predictedSet.size === 0 ? (expectedSet.size === 0 ? 1 : 0) : truePositives / predictedSet.size,
      recall: expectedSet.size === 0 ? (predictedSet.size === 0 ? 1 : 0) : truePositives / expectedSet.size,
      f1,
    }
    const ownCounts = countsFromLabels(labelMap, expected)
    const ownPairs = pairsFromLabels(labelMap, expected)
    selfConsistency = Boolean(ownCounts && parsed?.countsValid && equalCounts(ownCounts, parsed.counts) && ownPairs && parsed?.pairsValid && equalPairSets(ownPairs, parsed.pairs))
  } else {
    const ownCounts = countsFromLabels(labelMap, expected)
    selfConsistency = Boolean(ownCounts && parsed?.countsValid && equalCounts(ownCounts, parsed.counts))
  }
  const schemaValid = Boolean(parsed?.schemaValid && !goldError)
  const primaryScore = !schemaValid
    ? 0
    : expected?.kind === 'q03'
      ? pairMetrics.f1
      : labelAccuracy
  return {
    primaryScore,
    labelAccuracy,
    countsExact,
    pairsExact,
    selfConsistency,
    schemaValid,
    coverage: parsed?.coverage ?? {
      expectedCount: expected?.ids.length ?? 0,
      providedCount: 0,
      validLabelCount: 0,
      missingIds: expected?.ids ?? [],
      duplicateIds: [],
      unexpectedIds: [],
      invalidIds: [],
      invalidLabels: [],
      completeUnique: false,
    },
    errors: [...(goldError ? [goldError.message] : []), ...(parsed?.errors ?? [])],
    ...(pairMetrics ? { pairPrecision: pairMetrics.precision, pairRecall: pairMetrics.recall, pairF1: pairMetrics.f1 } : {}),
  }
}

/** Grade one model answer without trusting privateGold.counts or privateGold.pairs. */
export function gradeTask(task, answerText) {
  let expected
  try {
    expected = deriveExpected(task)
  } catch (error) {
    return baseResult(null, null, error)
  }
  const parsed = parseAnswer(answerText, expected)
  return baseResult(expected, parsed)
}

function parsePublicRecords(task) {
  const text = task?.inputFiles?.['inputs/records.jsonl']
  if (typeof text !== 'string') throw new Error('RLM_PUBLIC_INPUT: records.jsonl must be a string')
  const records = []
  for (const [lineIndex, line] of text.split(/\r?\n/).entries()) {
    if (!line && lineIndex === text.split(/\r?\n/).length - 1) continue
    if (!line) throw new Error(`RLM_PUBLIC_INPUT: blank record line ${lineIndex}`)
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      throw new Error(`RLM_PUBLIC_INPUT: invalid JSON at line ${lineIndex}: ${error.message}`)
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !hasExactKeys(parsed, ['id', 'user', 'text'])) {
      throw new Error(`RLM_PUBLIC_INPUT: record ${lineIndex} has private or unexpected fields`)
    }
    if (typeof parsed.id !== 'string' || !knownUser(parsed.user) || typeof parsed.text !== 'string') {
      throw new Error(`RLM_PUBLIC_INPUT: record ${lineIndex} has invalid public fields`)
    }
    if (/\|\|\s*Label\s*:/i.test(parsed.text)) throw new Error(`RLM_PUBLIC_INPUT: record ${lineIndex} leaks a label suffix`)
    records.push(parsed)
  }
  return records
}

function normaliseOfficialNumeric(value) {
  if (Number.isSafeInteger(value)) return value
  if (Array.isArray(value) && value.length === 1 && Number.isSafeInteger(value[0])) return value[0]
  if (typeof value === 'string') {
    try {
      return normaliseOfficialNumeric(JSON.parse(value))
    } catch {
      return null
    }
  }
  return null
}

function compareStoredCounts(privateGold, derivedCounts) {
  return Boolean(privateGold && privateGold.counts && hasExactKeys(privateGold.counts, LABELS) && equalCounts(privateGold.counts, derivedCounts))
}

function compareStoredPairs(privateGold, derivedPairs) {
  if (!privateGold || !Array.isArray(privateGold.pairs)) return false
  return equalPairSets(privateGold.pairs, derivedPairs)
}

/** Audit public/private alignment, leakage, stored-oracle mutations and numeric source gold. */
export function auditTask(task) {
  const errors = []
  let expected = null
  try {
    expected = deriveExpected(task)
  } catch (error) {
    errors.push(error.message)
  }

  let publicRecords = []
  let publicParseValid = true
  try {
    publicRecords = parsePublicRecords(task)
  } catch (error) {
    publicParseValid = false
    errors.push(error.message)
  }

  const publicById = new Map()
  const duplicatePublicIds = []
  for (const record of publicRecords) {
    if (publicById.has(record.id)) duplicatePublicIds.push(record.id)
    publicById.set(record.id, record)
  }

  let publicPrivateOneToOne = false
  if (expected) {
    publicPrivateOneToOne = publicRecords.length === expected.records.length && duplicatePublicIds.length === 0 && expected.records.every(record => {
      const publicRecord = publicById.get(record.id)
      return publicRecord && publicRecord.user === record.user && publicRecord.text === record.text
    })
    if (!publicPrivateOneToOne) errors.push('RLM_ALIGNMENT: public records are not a one-to-one match for private records')
    if (task.recordCount !== expected.records.length) errors.push('RLM_ALIGNMENT: recordCount does not match private records')
  }

  const publicText = [
    task?.inputFiles?.['inputs/records.jsonl'],
    task?.inputFiles?.['inputs/rules.md'],
    task?.instruction,
  ].filter(value => typeof value === 'string').join('\n')
  const sourceRowId = task?.provenance?.rowId ?? task?.privateGold?.source?.rowId
  const sourceWindowId = task?.provenance?.contextWindowId ?? task?.privateGold?.source?.contextWindowId
  const sourceLeak = [sourceRowId, sourceWindowId]
    .filter(value => value !== null && value !== undefined)
    .map(String)
    .some(value => value.length >= 4 && publicText.includes(value))
  const noLabelLeakage = publicParseValid && !sourceLeak && !publicText.includes('privateGold') && !/\|\|\s*Label\s*:/i.test(publicText) && duplicatePublicIds.length === 0
  if (!noLabelLeakage) errors.push('RLM_LEAK: public inputs contain private metadata or duplicate records')

  const storedCountsConsistent = Boolean(expected && compareStoredCounts(task?.privateGold, expected.counts))
  if (!storedCountsConsistent) errors.push('RLM_GOLD: stored counts differ from independently derived counts')
  let storedPairsConsistent = false
  if (expected) {
    const hasStoredPairs = Object.prototype.hasOwnProperty.call(task?.privateGold ?? {}, 'pairs')
    storedPairsConsistent = expected.kind !== 'q03' && !hasStoredPairs
      ? true
      : compareStoredPairs(task?.privateGold, expected.pairs)
  }
  if (!storedPairsConsistent) errors.push('RLM_GOLD: stored pairs differ from independently derived pairs')

  const official = task?.privateGold?.official ?? task?.privateGold?.source?.official ?? null
  const nestedOfficial = task?.privateGold?.source?.official ?? null
  const officialLabel = official?.label
  const officialNumeric = normaliseOfficialNumeric(official?.numeric ?? official?.answer)
  let officialNumericMatch = null
  if (officialNumeric !== null || officialLabel !== null && officialLabel !== undefined) {
    officialNumericMatch = Boolean(expected && LABEL_SET.has(officialLabel) && officialNumeric !== null && expected.counts[officialLabel] === officialNumeric)
    if (!officialNumericMatch) errors.push('RLM_OFFICIAL: numeric source answer does not match the independently counted label')
  }
  const officialCopiesConsistent = !nestedOfficial || JSON.stringify(nestedOfficial) === JSON.stringify(task?.privateGold?.official ?? nestedOfficial)
  if (!officialCopiesConsistent) errors.push('RLM_OFFICIAL: duplicated official gold copies differ')

  const checks = {
    publicPrivateOneToOne,
    noLabelLeakage,
    officialNumericChecked: officialNumericMatch !== null,
    officialNumericMatch,
    officialCopiesConsistent,
    storedCountsConsistent,
    storedPairsConsistent,
    publicRecordCount: publicRecords.length,
    privateRecordCount: expected?.records.length ?? 0,
    duplicatePublicIds: [...new Set(duplicatePublicIds)],
  }
  return {
    ok: errors.length === 0,
    valid: errors.length === 0,
    publicPrivateOneToOne,
    noLabelLeakage,
    officialNumericMatch,
    storedCountsConsistent,
    storedPairsConsistent,
    checks,
    errors: [...new Set(errors)],
  }
}

export { LABELS, USER_COUNT }
