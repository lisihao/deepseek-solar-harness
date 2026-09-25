/** Build an unsigned unpacked application for the current host platform. */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const builderCli = require.resolve('electron-builder/cli.js')
const nodePtyVerifier = fileURLToPath(new URL('./verify-packaged-node-pty.ts', import.meta.url))
const result = spawnSync(process.execPath, [builderCli, '--dir'], {
  cwd: packageRoot,
  env: {
    ...process.env,
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  },
  stdio: 'inherit',
})

if (result.error !== undefined) throw result.error
if (result.status !== 0) {
  throw new Error(`electron-builder --dir exited with ${String(result.status)}`)
}

if (process.platform === 'darwin') {
  const verification = spawnSync(process.execPath, [nodePtyVerifier], {
    cwd: packageRoot,
    env: process.env,
    stdio: 'inherit',
  })
  if (verification.error !== undefined) throw verification.error
  if (verification.status !== 0) {
    throw new Error(`packaged node-pty verification exited with ${String(verification.status)}`)
  }
}
