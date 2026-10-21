import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { loadTask, gradeTask, DATASET_REVISION, SCORER_COMMIT, SCORER_SHA256 } from './task.mjs'
const sha = x => createHash('sha256').update(x).digest('hex')
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bare-quality-task-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'task.json'), scorer = join(dir, 'eval_helpers.py')
  await writeFile(scorer, 'raise RuntimeError("must not execute an unpinned scorer")\n')
  const task = { formatVersion: 1, kind: 'paper-oolong-task-v1', id: 'test-only',
    context: 'test material', question: 'test question', answerType: 'ANSWER_TYPE.NUMERIC',
    source: { repository: 'oolongbench/oolong-synth', revision: DATASET_REVISION, dataset: 'trec_coarse', rowId: 1, contextWindowId: 1, contextLength: 32768, contextSha256: sha('test material'), questionSha256: sha('test question') },
    privateGold: { answer: '[3]' }, scorer: { path: scorer, commit: SCORER_COMMIT, sha256: SCORER_SHA256 } }
  return { task, path, save: () => writeFile(path, JSON.stringify(task)) }
}
test('refuse a custom substitute dataset before reading scorer or loading a provider', async t => {
  const f = await fixture(t); f.task.source.dataset = 'multinli'; await f.save()
  await assert.rejects(loadTask(f.path), /pinned original TREC/)
})
test('refuse changed public bytes with unchanged declared source hash', async t => {
  const f = await fixture(t); f.task.context += ' altered'; await f.save()
  await assert.rejects(loadTask(f.path), /input hash mismatch/)
})
test('refuse changed official scorer bytes rather than execute them', async t => {
  const f = await fixture(t); await f.save()
  await assert.rejects(loadTask(f.path), /scorer bytes changed/)
  await assert.rejects(gradeTask(f.task, '3'), /scorer bytes changed/)
})
test('refuse nonnumeric or malformed gold rather than guess', async t => {
  const f = await fixture(t); f.task.privateGold.answer = '3'; await f.save()
  await assert.rejects(loadTask(f.path), /invalid official numeric gold/)
})
test('never coerce structured model output to an answer string', async () => {
  await assert.rejects(gradeTask({}, { answer: '3' }), /answer must be a string/)
})
