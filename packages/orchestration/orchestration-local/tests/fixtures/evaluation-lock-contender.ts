/**
 * One contender for a ledger owner lock, run in its own process by `evaluation-ledger.spec.ts`. It waits until the start time all
 * contenders were given, tries to take the lock, and if it wins checks that nobody else holds it at the same moment: it creates
 * a marker file exclusively, keeps the lock for a while, and removes the marker before it releases the lock. It prints `won`,
 * `locked`, or `overlap` and exits.
 */
import { closeSync, openSync, unlinkSync } from 'node:fs'
import { EvaluationLedgerError, takeEvaluationOwnerLock } from '../../src/evaluation-ledger.ts'

const [lockPath, marker, startAt] = process.argv.slice(2)
if (lockPath === undefined || marker === undefined || startAt === undefined) throw new Error('usage: lockPath marker startAt')
while (Date.now() < Number(startAt)) { /* spin until the common start time */ }

try {
  const lock = takeEvaluationOwnerLock(lockPath)
  let outcome = 'won'
  try {
    closeSync(openSync(marker, 'wx'))
  } catch {
    outcome = 'overlap'
  }
  const hold = Date.now() + 150
  while (Date.now() < hold) { /* hold the lock while the others try */ }
  if (outcome === 'won') unlinkSync(marker)
  lock.release()
  process.stdout.write(`${outcome}\n`)
} catch (error) {
  if (!(error instanceof EvaluationLedgerError) || error.code !== 'EVALUATION_LEDGER_LOCKED') throw error
  process.stdout.write('locked\n')
}
