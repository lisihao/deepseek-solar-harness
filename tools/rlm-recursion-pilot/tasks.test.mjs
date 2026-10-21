import test from 'node:test'
import assert from 'node:assert/strict'

import { prepareTasks } from './tasks.mjs'
import { auditTask, gradeTask } from './grader.mjs'

function makeRow({ id, window, records, question, answer }) {
  const raw = records.map(({ index, user, premise, hypothesis }) =>
    `Date: 2026-10-${String(index + 1).padStart(2, '0')} || User: ${user} || Instance: ${premise} -> ${hypothesis}`)
  const labelled = records.map(({ index, user, premise, hypothesis, label }) =>
    `Date: 2026-10-${String(index + 1).padStart(2, '0')} || User: ${user} || Instance: ${premise} -> ${hypothesis} || Label: ${label}`)
  return {
    id,
    context_window_id: window,
    context_len: 70016,
    context_window_text: raw.join('\n'),
    context_window_text_with_labels: labelled.join('\n'),
    question,
    answer,
    answer_type: 'integer',
  }
}

function clone(value) {
  return structuredClone(value)
}

const q02Records = [
  { index: 0, user: 'source-a', premise: 'the sky is blue', hypothesis: 'the sky has color', label: 'entailment' },
  { index: 1, user: 'source-b', premise: 'the lamp is on', hypothesis: 'the lamp is off', label: 'contradiction' },
  { index: 2, user: 'source-c', premise: 'the train arrived', hypothesis: 'the train is large', label: 'neutral' },
  { index: 3, user: 'source-d', premise: 'the cup is empty', hypothesis: 'the cup contains nothing', label: 'entailment' },
  { index: 4, user: 'source-e', premise: 'the door is closed', hypothesis: 'the door is open', label: 'contradiction' },
  { index: 5, user: 'source-f', premise: 'the cat sleeps', hypothesis: 'the cat is indoors', label: 'neutral' },
  { index: 6, user: 'source-g', premise: 'the bell rings', hypothesis: 'a sound occurs', label: 'entailment' },
  { index: 7, user: 'source-h', premise: 'the box is heavy', hypothesis: 'the box is light', label: 'contradiction' },
]

const q03Records = Array.from({ length: 64 }, (_unused, index) => {
  const userIndex = Math.floor(index / 2)
  const contradictionGroup = userIndex < 4
  const label = contradictionGroup ? 'contradiction' : 'neutral'
  return {
    index,
    user: `source-${userIndex}`,
    premise: `fact ${index}`,
    hypothesis: `claim ${index}`,
    label,
  }
})

function makeTasks() {
  return prepareTasks([
    makeRow({
      id: 'row715070021',
      window: 70016,
      records: q02Records,
      question: 'Count label entailment records',
      answer: '[3]',
    }),
    makeRow({
      id: 'row715070046',
      window: 70017,
      records: q03Records,
      question: 'Count label neutral records',
      answer: '[56]',
    }),
  ], { salt: 'synthetic-salt' })
}

function answerFor(task, { reorder = false } = {}) {
  const labels = task.privateGold.records.map(record => ({ id: record.id, label: record.label }))
  if (reorder) labels.reverse()
  const answer = {
    labels,
    counts: { ...task.privateGold.counts },
  }
  if (task.privateGold.taskKind === 'q03') answer.pairs = task.privateGold.pairs.map(pair => [...pair])
  return JSON.stringify(answer)
}

test('prepareTasks emits deterministic public/private task records without leakage', () => {
  const tasks = makeTasks()
  assert.equal(tasks.length, 2)
  assert.deepEqual(tasks.map(task => task.family), ['oolong-multinli', 'oolong-multinli'])
  assert.deepEqual(tasks.map(task => task.recordCount), [8, 64])
  for (const task of tasks) {
    assert.ok(task.id)
    assert.ok(task.instruction.includes('14 model requests'))
    assert.ok(task.inputFiles['inputs/records.jsonl'].endsWith('\n'))
    assert.ok(!task.inputFiles['records.jsonl'])
    assert.equal(task.inputFiles['inputs/records.jsonl'].includes(task.provenance.rowId), false)
    assert.equal(task.inputFiles['inputs/rules.md'].includes(task.provenance.rowId), false)
    for (const line of task.inputFiles['inputs/records.jsonl'].trimEnd().split('\n')) {
      const record = JSON.parse(line)
      assert.deepEqual(Object.keys(record).sort(), ['id', 'text', 'user'])
      assert.match(record.id, /^r\d{4}$/)
      assert.match(record.user, /^u(?:[0-2]\d|3[01])$/)
      assert.equal(record.text.includes('|| Label:'), false)
    }
    assert.equal(auditTask(task).ok, true)
  }
})

test('same salt is byte-deterministic and a different salt changes the order', () => {
  const first = makeTasks()
  const second = prepareTasks([
    makeRow({ id: 'row715070021', window: 70016, records: q02Records, question: 'Count label entailment records', answer: '[3]' }),
    makeRow({ id: 'row715070046', window: 70017, records: q03Records, question: 'Count label neutral records', answer: '[56]' }),
  ], { salt: 'synthetic-salt' })
  const changed = prepareTasks([
    makeRow({ id: 'row715070021', window: 70016, records: q02Records, question: 'Count label entailment records', answer: '[3]' }),
    makeRow({ id: 'row715070046', window: 70017, records: q03Records, question: 'Count label neutral records', answer: '[56]' }),
  ], { salt: 'other-salt' })
  assert.deepEqual(first, second)
  assert.notEqual(first[0].inputFiles['inputs/records.jsonl'], changed[0].inputFiles['inputs/records.jsonl'])
})

test('q02 grading scores labels, detects count errors and is invariant to label order', () => {
  const task = makeTasks()[0]
  const correct = gradeTask(task, answerFor(task, { reorder: true }))
  assert.equal(correct.primaryScore, 1)
  assert.equal(correct.labelAccuracy, 1)
  assert.equal(correct.countsExact, true)
  assert.equal(correct.selfConsistency, true)
  assert.equal(correct.schemaValid, true)

  const wrongLabel = JSON.parse(answerFor(task))
  wrongLabel.labels[0].label = wrongLabel.labels[0].label === 'neutral' ? 'entailment' : 'neutral'
  const wrong = gradeTask(task, JSON.stringify(wrongLabel))
  assert.equal(wrong.schemaValid, true)
  assert.ok(wrong.labelAccuracy < 1)
  assert.equal(wrong.primaryScore, wrong.labelAccuracy)

  const wrongCount = JSON.parse(answerFor(task))
  wrongCount.counts.entailment += 1
  const countResult = gradeTask(task, JSON.stringify(wrongCount))
  assert.equal(countResult.primaryScore, 1)
  assert.equal(countResult.countsExact, false)
  assert.equal(countResult.selfConsistency, false)
})

test('strict coverage and schema checks retain missing/duplicate diagnostics', () => {
  const task = makeTasks()[0]
  const answer = JSON.parse(answerFor(task))
  answer.labels.pop()
  answer.labels.push({ ...answer.labels[0] })
  const result = gradeTask(task, JSON.stringify(answer))
  assert.equal(result.primaryScore, 0)
  assert.equal(result.schemaValid, false)
  assert.ok(result.coverage.duplicateIds.length >= 1)
  assert.ok(result.coverage.missingIds.length >= 1)

  const malformed = gradeTask(task, '{"labels":')
  assert.equal(malformed.primaryScore, 0)
  assert.equal(malformed.coverage.expectedCount, task.recordCount)
})

test('q03 uses the unordered pair F1 and rejects reversed or duplicate pairs', () => {
  const task = makeTasks()[1]
  const correct = gradeTask(task, answerFor(task))
  assert.equal(correct.primaryScore, 1)
  assert.equal(correct.pairsExact, true)
  assert.equal(correct.pairF1, 1)

  const reorderedPairs = JSON.parse(answerFor(task))
  reorderedPairs.pairs.reverse()
  assert.equal(gradeTask(task, JSON.stringify(reorderedPairs)).primaryScore, 1)

  const fakePair = JSON.parse(answerFor(task))
  fakePair.pairs.push(['u00', 'u31'])
  const fakeResult = gradeTask(task, JSON.stringify(fakePair))
  assert.equal(fakeResult.schemaValid, true)
  assert.equal(fakeResult.pairsExact, false)
  assert.ok(fakeResult.pairF1 < 1)

  const reversed = JSON.parse(answerFor(task))
  reversed.pairs = [['u01', 'u00']]
  const reversedResult = gradeTask(task, JSON.stringify(reversed))
  assert.equal(reversedResult.primaryScore, 0)
  assert.equal(reversedResult.schemaValid, false)
})

test('audit rejects public label leakage and detects mutated original gold', () => {
  const task = makeTasks()[0]
  const leaked = clone(task)
  const firstLine = leaked.inputFiles['inputs/records.jsonl'].trimEnd().split('\n')[0]
  const firstRecord = JSON.parse(firstLine)
  firstRecord.label = 'entailment'
  leaked.inputFiles['inputs/records.jsonl'] = [JSON.stringify(firstRecord), ...leaked.inputFiles['inputs/records.jsonl'].trimEnd().split('\n').slice(1)].join('\n') + '\n'
  const leakAudit = auditTask(leaked)
  assert.equal(leakAudit.ok, false)
  assert.equal(leakAudit.checks.noLabelLeakage, false)

  const mutated = clone(task)
  mutated.privateGold.records[0].label = mutated.privateGold.records[0].label === 'neutral' ? 'entailment' : 'neutral'
  const mutationAudit = auditTask(mutated)
  assert.equal(mutationAudit.ok, false)
  assert.equal(mutationAudit.checks.storedCountsConsistent, false)
})

test('source alignment requires exact one-to-one body matching', () => {
  const bad = makeRow({
    id: 'row715070021',
    window: 70016,
    records: q02Records,
    question: 'Count label entailment records',
    answer: '[3]',
  })
  bad.context_window_text_with_labels = bad.context_window_text_with_labels.replace('the sky has color', 'the sky is green')
  assert.throws(() => prepareTasks([bad, makeRow({ id: 'row715070046', window: 70017, records: q03Records, question: 'Count label neutral records', answer: '[56]' })]), /RLM_SOURCE_ALIGNMENT/)
})
