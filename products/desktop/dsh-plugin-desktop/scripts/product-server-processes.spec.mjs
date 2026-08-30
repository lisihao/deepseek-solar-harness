import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertOwnedDaemonCommand, stopProductServerDaemons } from './product-server-processes.mjs'

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
