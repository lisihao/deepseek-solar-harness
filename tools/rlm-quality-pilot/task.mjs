import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

export const DATASET_REVISION = '616cca899e8b51ea0ad5446ebab39aa72b3192bc'
export const SCORER_COMMIT = '0bb7eabe839218fee7fe8d007f41cfc2fd3ae24c'
export const SCORER_SHA256 = '247583a3b653b91c39fb88a102460802f1493175b23d05a7217aead0d685c64c'
const adapter = fileURLToPath(new URL('./official-score.py', import.meta.url))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const record = value => value && typeof value === 'object' && !Array.isArray(value)
function requireThat(ok, text) { if (!ok) throw new Error(`OOLONG_TASK: ${text}`) }

/** Public input and private gold travel together only in the unsandboxed parent. */
export async function loadTask(path) {
  requireThat(typeof path === 'string' && isAbsolute(path), 'task path must be absolute')
  const bytes = await readFile(path)
  requireThat(bytes.length < 16 * 1024 * 1024, 'task artifact exceeds 16 MiB')
  const task = JSON.parse(bytes.toString('utf8'))
  requireThat(record(task) && task.formatVersion === 1 && task.kind === 'paper-oolong-task-v1', 'unsupported artifact')
  requireThat(typeof task.id === 'string' && /^[a-zA-Z0-9_-]+$/.test(task.id), 'invalid task id')
  requireThat(typeof task.context === 'string' && task.context.length > 0 && typeof task.question === 'string' && task.question.length > 0, 'missing original material or question')
  requireThat(task.answerType === 'ANSWER_TYPE.NUMERIC', 'this pilot supports the official numeric task only')
  const source = task.source
  requireThat(record(source) && source.repository === 'oolongbench/oolong-synth' && source.revision === DATASET_REVISION && source.dataset === 'trec_coarse', 'source must be the pinned original TREC dataset')
  requireThat(Number.isSafeInteger(source.rowId) && Number.isSafeInteger(source.contextWindowId) && [32768, 65536].includes(source.contextLength), 'invalid source row, context window, or length')
  requireThat(source.contextSha256 === hash(task.context) && source.questionSha256 === hash(task.question), 'public input hash mismatch')
  requireThat(record(task.privateGold) && typeof task.privateGold.answer === 'string' && /^\[\d+\]$/.test(task.privateGold.answer), 'invalid official numeric gold')
  requireThat(record(task.scorer) && task.scorer.commit === SCORER_COMMIT && task.scorer.sha256 === SCORER_SHA256 && typeof task.scorer.path === 'string' && isAbsolute(task.scorer.path), 'invalid official scorer pin')
  requireThat(hash(await readFile(task.scorer.path)) === SCORER_SHA256, 'official scorer bytes changed')
  return { ...task, inputFiles: { 'inputs/context.txt': task.context }, artifactSha256: hash(bytes) }
}

/** Execute only the two unchanged synth functions from the pinned source. */
export async function gradeTask(task, answerText) {
  requireThat(typeof answerText === 'string', 'answer must be a string')
  requireThat(task?.scorer?.sha256 === SCORER_SHA256 && task?.answerType === 'ANSWER_TYPE.NUMERIC', 'unsupported scorer or answer type')
  requireThat(hash(await readFile(task.scorer.path)) === SCORER_SHA256, 'official scorer bytes changed')
  const payload = JSON.stringify({
    sourcePath: task.scorer.path, expectedSha256: SCORER_SHA256,
    datapoint: { id: task.source.rowId, context_window_id: task.source.contextWindowId,
      dataset: task.source.dataset, answer: task.privateGold.answer, answer_type: task.answerType },
    output: answerText,
  })
  const result = await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', ['-I', adapter], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' } })
    let stdout = '', stderr = '', completed = false
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('OOLONG_SCORER: timed out')) }, 10000)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.stdout.on('data', bytes => { stdout += bytes; if (stdout.length > 4 * 1024 * 1024) child.kill('SIGKILL') })
    child.stderr.on('data', bytes => { stderr += bytes; if (stderr.length > 65536) child.kill('SIGKILL') })
    child.on('close', code => { clearTimeout(timer); if (completed) return; completed = true
      if (code !== 0) reject(new Error(`OOLONG_SCORER: exit ${code}: ${stderr.slice(0, 2000)}`))
      else { try { resolve(JSON.parse(stdout)) } catch (error) { reject(error) } }
    })
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error) })
    child.stdin.end(payload)
  })
  requireThat(typeof result.score === 'number' && Number.isFinite(result.score) && result.score >= 0 && result.score <= 1, 'official scorer returned invalid score')
  return { score: result.score, primaryScore: result.score,
    exact: result.attempted_parse === result.answer,
    attemptedParse: result.attempted_parse, gold: result.answer,
    parseConfidence: result.parse_confidence, official: result,
    scorerSha256: SCORER_SHA256 }
}
