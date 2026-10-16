// Preloaded (`--import`) into the daemon processes of a fixture fault run. A daemon publishes its pid file from the callback of
// its first `listen`; swallowing `listen` keeps a real, detached daemon process alive with no pid file for as long as the fault
// lasts, which is the window in which a pid-file-only cleanup cannot find it. The process ends only by a signal. The switch
// lists the daemons to hold ("orchestration", "resident"); the others start normally.
import net from 'node:net'

const entry = process.argv[1] ?? ''
const kind = /\/orchestration-local\//u.test(entry) ? 'orchestration' : /\/resident-operator-local\//u.test(entry) ? 'resident' : undefined
if (kind !== undefined && (process.env.DSH_FIXTURE_HOLD_LISTEN ?? '').split(',').includes(kind)) {
  net.Server.prototype.listen = function listen() { return this }
  setInterval(() => undefined, 1 << 30)
}
