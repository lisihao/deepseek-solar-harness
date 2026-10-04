// Stand-in for dsh-gouzi-worker with controllable faults. The file name contains "gouzi-worker" because the
// supervisor recognizes a member process by its command line.
//   STAND_IN_MODE=ready      write the ready record after STAND_IN_DELAY_MS, exit on SIGTERM
//   STAND_IN_MODE=stubborn   write the ready record, ignore SIGTERM
//   STAND_IN_MODE=silent     never write the ready record, ignore SIGTERM
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env.DSH_HOME
const mode = process.env.STAND_IN_MODE ?? 'ready'
appendFileSync(join(home, 'spawns.log'), `${String(process.pid)}\n`)
if (mode !== 'ready') process.on('SIGTERM', () => {})
else process.on('SIGTERM', () => { process.exit(0) })
setTimeout(() => {
  if (mode === 'silent') return
  mkdirSync(join(home, 'gouzi'), { recursive: true })
  writeFileSync(join(home, 'gouzi', 'worker.json'), `${JSON.stringify({
    event: 'gouzi-worker-ready', pid: process.pid, port: 1, gouziId: 'stand-in', generation: 1, authorityEpoch: 'e', incarnation: 1,
  })}\n`)
}, Number(process.env.STAND_IN_DELAY_MS ?? 0))
setInterval(() => {}, 1000)
