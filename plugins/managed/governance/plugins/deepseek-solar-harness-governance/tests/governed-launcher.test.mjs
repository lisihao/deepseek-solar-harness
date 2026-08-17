import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const launcher = new URL('../bin/dsh-governed.mjs', import.meta.url)

test('launcher forwards SIGTERM and waits for the governed child to release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-governed-signal-'))
  const fake = join(root, 'fake-dsh.mjs')
  const marker = join(root, 'signal.txt')
  await writeFile(fake, `
import { writeFileSync } from 'node:fs'
if (process.argv.includes('--dump-config')) {
  console.log(\`- id: code-harness-invariants
  name: '@deepseek-ai/dsh-invariants'
  config:
    enabled: true
- id: code-harness-governance
  name: '@lisihao/dsh-code-harness-governance'
  config:
    strict: true
- id: code-harness-governance-invariant
  name: '@lisihao/dsh-code-harness-governance/invariant'\`)
  process.exit(0)
}
process.on('SIGTERM', () => {
  writeFileSync(process.env.SIGNAL_MARKER, 'SIGTERM')
  setTimeout(() => process.exit(0), 25)
})
console.log('fake-dsh-ready')
setInterval(() => {}, 1_000)
`)

  const child = spawn(process.execPath, [launcher.pathname, '--profile', 'web'], {
    env: {
      ...process.env,
      DSH_COMMAND_JSON: JSON.stringify([process.execPath, fake]),
      SIGNAL_MARKER: marker,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    await new Promise((resolve, reject) => {
      let output = ''
      const ready = (chunk) => {
        output += chunk.toString()
        if (output.includes('fake-dsh-ready')) resolve()
      }
      child.stdout.on('data', ready)
      child.once('error', reject)
    })
    child.kill('SIGTERM')
    const outcome = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => { resolve({ code, signal }) })
    })
    assert.deepEqual(outcome, { code: 0, signal: null })
    assert.equal(await readFile(marker, 'utf8'), 'SIGTERM')
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await rm(root, { recursive: true, force: true })
  }
})
