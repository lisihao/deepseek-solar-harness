import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { startResidentDaemon } from '../../incubator/native-resident/lib/daemon.js'

const root = process.argv[2]
await startResidentDaemon({ root, fingerprint: 'keyless-fixture' }, {
  codex: {
    async execute(request) {
      request.onSession(request.nativeSessionId ?? 'fixture-native-session')
      appendFileSync(join(root, 'dispatches.log'), request.commandId + '\n')
      if (request.prompt === 'wait-for-crash') {
        await new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(Object.assign(new Error('Fixture interrupted'), { code: 'COMMAND_CANCELLED' })), { once: true }))
      }
      return { output: 'keyless fixture result', nativeSessionId: 'fixture-native-session' }
    },
  },
})
console.log('FIXTURE_READY')
