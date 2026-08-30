import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertOwnedDaemonCommand, stopOwnedDaemon, stopProductServerDaemons } from './product-server-processes.mjs'

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null
}

test('stops daemon pids retained below a Product Server smoke home', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-product-processes-'))
  const residentRoot = join(home, 'resident-operators')
  const orchestrationRoot = join(home, 'orchestrations')
  await mkdir(residentRoot, { recursive: true })
  await mkdir(orchestrationRoot, { recursive: true })
  const resident = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', '--root', residentRoot], { stdio: 'ignore' })
  const orchestration = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', '--root', orchestrationRoot], { stdio: 'ignore' })
  try {
    assert.ok(resident.pid)
    assert.ok(orchestration.pid)
    await writeFile(join(residentRoot, 'daemon.pid'), `${String(resident.pid)}\n`)
    await writeFile(join(orchestrationRoot, 'daemon.pid'), `${String(orchestration.pid)}\n`)
    await stopProductServerDaemons(home)
    await Promise.all([
      new Promise(resolve => exited(resident) ? resolve() : resident.once('exit', resolve)),
      new Promise(resolve => exited(orchestration) ? resolve() : orchestration.once('exit', resolve)),
    ])
    assert.ok(exited(resident))
    assert.ok(exited(orchestration))
  } finally {
    if (!exited(resident)) resident.kill('SIGKILL')
    if (!exited(orchestration)) orchestration.kill('SIGKILL')
    await rm(home, { recursive: true, force: true })
  }
})

test('refuses a stale pid that does not prove executable and instance root', () => {
  assert.throws(() => assertOwnedDaemonCommand('/usr/bin/node daemon.js --root /tmp/other', '/tmp/expected'), /does not own root/)
  assert.throws(() => assertOwnedDaemonCommand('/tmp/not-node daemon.js --root /tmp/expected', '/tmp/expected'), /executable/)
})

test('accepts a daemon exit that races an unavailable owner socket', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-product-process-race-'))
  const root = join(home, 'resident-operators')
  await mkdir(root, { recursive: true })
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', '--root', root], { stdio: 'ignore' })
  try {
    assert.ok(child.pid)
    await writeFile(join(root, 'daemon.pid'), `${String(child.pid)}\n`)
    let inspected = false
    await stopOwnedDaemon(root, 1_000, {
      requestShutdown: async () => {
        child.kill('SIGTERM')
        await new Promise(resolve => exited(child) ? resolve() : child.once('exit', resolve))
        throw new Error('owner socket unavailable')
      },
      inspectProcess: async () => {
        inspected = true
        throw new Error('an exited daemon must not be inspected')
      },
    })
    assert.equal(inspected, false)
  } finally {
    if (!exited(child)) child.kill('SIGKILL')
    await rm(home, { recursive: true, force: true })
  }
})
