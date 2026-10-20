#!/opt/homebrew/opt/node@22/bin/node

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer as createTcpServer } from 'node:net'
import { createServer as createUnixServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { policy } from './sandbox.mjs'
import { __test } from './native-worker.mjs'

const NODE = '/opt/homebrew/opt/node@22/bin/node'

function capture(command, args, options = {}) {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(command, args, options)
    const stdout = []
    const stderr = []
    child.stdout.on('data', value => stdout.push(Buffer.from(value)))
    child.stderr.on('data', value => stderr.push(Buffer.from(value)))
    child.once('error', rejectResult)
    child.once('close', (code, signal) => resolveResult({ code, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }))
  })
}

async function listenUnix(path) {
  const server = createUnixServer(socket => socket.end())
  server.listen(path)
  await once(server, 'listening')
  return server
}

async function listenTcp() {
  const server = createTcpServer(socket => socket.end())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address !== 'string')
  return { server, port: address.port }
}

async function close(server) {
  if (!server.listening) return
  await new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()))
}

function testJsonBoundary() {
  const alias = { payload: 'shared-object' }
  const value = __test.exactJson({ left: alias, right: alias, optional: undefined }, 'alias fixture')
  assert.deepEqual(value, { left: { payload: 'shared-object' }, right: { payload: 'shared-object' } })
  assert.throws(() => __test.exactJson([undefined], 'array undefined'), /ARC_IPC_JSON/)
  assert.throws(() => __test.exactJson([Symbol('x')], 'array symbol'), /ARC_IPC_JSON/)
  assert.throws(() => __test.exactJson({ number: Number.NaN }, 'nan'), /ARC_IPC_JSON/)
  const cycle = { name: 'cycle' }
  cycle.self = cycle
  assert.throws(() => __test.exactJson(cycle, 'cycle'), /ARC_IPC_JSON.*cycle/)
}

function testStopLatch() {
  const latch = __test.createStopLatch()
  assert.equal(latch.reason, undefined)
  assert.equal(latch.note('provider unknown'), 'provider unknown')
  assert.equal(latch.reason, 'provider unknown')
  assert.equal(latch.note('later timeout'), 'provider unknown')
}

async function testSandbox() {
  const root = await mkdtemp('/private/tmp/arc-native-worker-test-')
  const run = join(root, 'run')
  const shared = join(root, 'shared')
  const privateRoot = join(root, 'private')
  const workspace = join(run, 'workspace')
  const data = join(run, 'data')
  const tmp = join(run, 'tmp')
  await Promise.all([
    mkdir(workspace, { recursive: true, mode: 0o700 }),
    mkdir(join(run, 'home'), { recursive: true, mode: 0o700 }),
    mkdir(tmp, { recursive: true, mode: 0o700 }),
    mkdir(data, { recursive: true, mode: 0o700 }),
    mkdir(shared, { recursive: true, mode: 0o700 }),
    mkdir(privateRoot, { recursive: true, mode: 0o700 }),
  ])
  const allowedFile = join(workspace, 'allowed.txt')
  const privateFile = join(privateRoot, 'secret.txt')
  await Promise.all([
    writeFile(allowedFile, 'allowed\n', { mode: 0o600 }),
    writeFile(privateFile, 'secret\n', { mode: 0o600 }),
  ])
  const guardSocket = join(run, 'guard.sock')
  const nativeSocket = join(data, 'prime.sock')
  const tmpSocket = join(tmp, 'prime-agent-worker.sock')
  const privateSocket = join(privateRoot, 'engine.sock')
  const [guard, native, nativeTmp, privateEngine, allowedTcp, blockedTcp] = await Promise.all([
    listenUnix(guardSocket),
    listenUnix(nativeSocket),
    listenUnix(tmpSocket),
    listenUnix(privateSocket),
    listenTcp(),
    listenTcp(),
  ])
  try {
    const profile = policy({
      directory: run,
      shared,
      readRoots: [],
      bridgePort: allowedTcp.port,
      brokerPrivateRoot: privateRoot,
      protectedRoots: [privateRoot],
    })
    assert.match(profile, new RegExp(`localhost:${String(allowedTcp.port)}`))
    assert.match(profile, /remote unix-socket/)
    const profilePath = join(run, 'sandbox.sb')
    await writeFile(profilePath, profile, { mode: 0o600 })
    const probe = String.raw`
      import fs from 'node:fs';
      import net from 'node:net';
      const read = path => { try { fs.readFileSync(path, 'utf8'); return { ok: true } } catch (error) { return { ok: false, code: error.code } } };
      const write = path => { try { fs.writeFileSync(path, 'x'); return { ok: true } } catch (error) { return { ok: false, code: error.code } } };
      const connect = options => new Promise(resolve => {
        const socket = net.connect(options);
        const timer = setTimeout(() => { socket.destroy(); resolve({ ok: false, code: 'TIMEOUT' }); }, 900);
        socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve({ ok: true }); });
        socket.once('error', error => { clearTimeout(timer); resolve({ ok: false, code: error.code }); });
      });
      const paths = JSON.parse(process.argv[1]);
      const result = {
        allowedRead: read(paths.allowedFile),
        usersRead: read(paths.usersFile),
        privateRead: read(paths.privateFile),
        ownWrite: write(paths.ownWrite),
        sharedWrite: write(paths.sharedWrite),
        allowedTcp: await connect({ host: '127.0.0.1', port: paths.allowedPort }),
        blockedTcp: await connect({ host: '127.0.0.1', port: paths.blockedPort }),
        publicIp: await connect({ host: '1.1.1.1', port: 443 }),
        guardUnix: await connect({ path: paths.guardSocket }),
        nativeUnix: await connect({ path: paths.nativeSocket }),
        tmpUnix: await connect({ path: paths.tmpSocket }),
        privateUnix: await connect({ path: paths.privateSocket }),
      };
      process.stdout.write(JSON.stringify(result));
    `
    const argv = JSON.stringify({
      allowedFile,
      usersFile: fileURLToPath(new URL('../../AGENTS.md', import.meta.url)),
      privateFile,
      ownWrite: join(workspace, 'owned-write.txt'),
      sharedWrite: join(shared, 'forbidden-write.txt'),
      allowedPort: allowedTcp.port,
      blockedPort: blockedTcp.port,
      guardSocket,
      nativeSocket,
      tmpSocket,
      privateSocket,
    })
    const probeRun = await capture('/usr/bin/sandbox-exec', ['-f', profilePath, NODE, '--input-type=module', '-e', probe, argv], { cwd: workspace, env: { PATH: '/opt/homebrew/opt/node@22/bin:/usr/bin:/bin', HOME: join(run, 'home'), TMPDIR: join(run, 'tmp') } })
    assert.equal(probeRun.code, 0, `sandbox probe failed: ${probeRun.stderr}`)
    const value = JSON.parse(probeRun.stdout)
    assert.deepEqual(value.allowedRead, { ok: true })
    assert.deepEqual(value.ownWrite, { ok: true })
    assert.deepEqual(value.allowedTcp, { ok: true })
    assert.deepEqual(value.guardUnix, { ok: true })
    assert.deepEqual(value.nativeUnix, { ok: true })
    assert.deepEqual(value.tmpUnix, { ok: true })
    for (const name of ['usersRead', 'privateRead', 'sharedWrite', 'blockedTcp', 'publicIp', 'privateUnix']) {
      assert.equal(value[name].ok, false, `${name} unexpectedly succeeded`)
      assert.equal(value[name].code, 'EPERM', `${name} failed as ${String(value[name].code)}, not EPERM`)
    }
    return { root, result: value }
  } finally {
    await Promise.allSettled([close(guard), close(native), close(nativeTmp), close(privateEngine), close(allowedTcp.server), close(blockedTcp.server)])
  }
}

async function main() {
  assert.equal(process.versions.node.split('.')[0], '22', `expected Node 22, got ${process.version}`)
  testJsonBoundary()
  testStopLatch()
  const sandbox = await testSandbox()
  process.stdout.write(`${JSON.stringify({ status: 'passed', sandboxRoot: sandbox.root, sandbox: sandbox.result })}\n`)
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error.message}\n`)
  process.exitCode = 1
})
