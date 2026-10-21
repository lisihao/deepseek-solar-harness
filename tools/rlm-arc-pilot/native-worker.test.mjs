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

function testImportedWorkerDoesNotListenForIpc() {
  assert.equal(process.listenerCount('message'), 0, 'importing the worker must not install its IPC listener')
  assert.equal(process.listenerCount('disconnect'), 0, 'importing the worker must not install its disconnect listener')
}

async function configFixture() {
  const root = await mkdtemp('/private/tmp/arc-native-worker-config-')
  const directory = join(root, 'run')
  const shared = join(root, 'shared')
  const compiled = join(shared, 'compiled')
  const packageRoot = join(shared, 'package')
  await Promise.all([
    mkdir(join(directory, 'workspace'), { recursive: true, mode: 0o700 }),
    mkdir(join(directory, 'home'), { recursive: true, mode: 0o700 }),
    mkdir(join(directory, 'tmp'), { recursive: true, mode: 0o700 }),
    mkdir(join(directory, 'data'), { recursive: true, mode: 0o700 }),
    mkdir(compiled, { recursive: true, mode: 0o700 }),
    mkdir(packageRoot, { recursive: true, mode: 0o700 }),
  ])
  return {
    directory,
    shared,
    compiled,
    packageRoot,
    base: {
      type: 'start',
      directory,
      shared,
      compiled,
      packageRoot,
      task: 'Read inputs from the working directory and write the requested answer.',
      route: { provider: 'openai-codex', model: 'gpt-6.1-sol', reasoningEffort: 'high', maxTokens: 16_384 },
      modelInfo: { name: 'fixed-model', context: { contextWindow: 128_000 }, inputModalities: ['text'] },
      bridgePort: 14_001,
      dependencyReadRoots: [packageRoot],
    },
  }
}

function sameRecursionConfig(config) {
  const { original: _original, arm: _arm, nativeDepth: _nativeDepth, ...same } = config
  return same
}

async function testConfigModes() {
  const fixture = await configFixture()
  const arcStart = {
    ...fixture.base,
    arm: 'S',
    requestLimit: 32,
    wallTimeMs: 3_600_000,
    autonomous: { maxTurns: 32, maxTokens: 4_000_000, gate: 'test -f answer.json' },
    brokerSocket: join(fixture.directory, 'broker.sock'),
    brokerState: join(fixture.directory, 'broker-state'),
  }
  const arc = await __test.normalizeConfig(arcStart)
  assert.equal(arc.protocol, 'arc-pilot-v1')
  assert.equal(arc.nativeDepth, 0)
  assert.equal(arc.requestLimit, 32)
  assert.equal(arc.wallTimeMs, 3_600_000)
  assert.deepEqual(arc.autonomous, { maxTurns: 32, maxTokens: 4_000_000, gate: 'test -f answer.json' })
  assert.equal((await __test.normalizeConfig({ ...arcStart, arm: 'R' })).nativeDepth, 0)
  const arcWithoutBroker = { ...arcStart }
  delete arcWithoutBroker.brokerSocket
  delete arcWithoutBroker.brokerState
  await assert.rejects(() => __test.normalizeConfig(arcWithoutBroker), /ARC_WORKER_CONFIG/)

  const qualityStart = arm => ({
    ...fixture.base,
    protocol: 'quality-pilot-v1',
    arm,
    requestLimit: 32,
    wallTimeMs: 1_200_000,
    autonomous: { maxTurns: 32, maxTokens: 4_000_000, gate: 'test -f answer.json' },
  })
  const qualityR = await __test.normalizeConfig(qualityStart('R'))
  const qualityS = await __test.normalizeConfig(qualityStart('S'))
  for (const quality of [qualityR, qualityS]) {
    assert.equal(quality.protocol, 'quality-pilot-v1')
    assert.equal(quality.nativeDepth, 1)
    assert.equal(quality.requestLimit, 32)
    assert.equal(quality.wallTimeMs, 1_200_000)
    assert.deepEqual(quality.autonomous, { maxTurns: 32, maxTokens: 4_000_000, gate: 'test -f answer.json' })
    assert.equal(quality.brokerSocket, undefined)
    assert.equal(quality.brokerState, undefined)
  }
  assert.equal(qualityR.arm, 'R')
  assert.equal(qualityS.arm, 'S')
  assert.equal(__test.defaultNativeDepth('quality-pilot-v1', 'R'), 1)
  assert.equal(__test.defaultNativeDepth('quality-pilot-v1', 'S'), 1)
  await assert.rejects(() => __test.normalizeConfig({ ...qualityStart('S0') }), /ARC_WORKER_CONFIG/)
  await assert.rejects(() => __test.normalizeConfig({ ...qualityStart('R'), requestLimit: 14 }), /ARC_REQUEST_LIMIT_CHANGED/)
  await assert.rejects(() => __test.normalizeConfig({ ...qualityStart('R'), wallTimeMs: 3_600_000 }), /ARC_WALL_TIME_CHANGED/)
  await assert.rejects(() => __test.normalizeConfig({
    ...qualityStart('R'),
    autonomous: { maxTurns: 14, maxTokens: 4_000_000, gate: 'test -f answer.json' },
  }), /ARC_AUTONOMOUS_CHANGED/)
  await assert.rejects(() => __test.normalizeConfig({
    ...qualityStart('S'),
    autonomous: { maxTurns: 32, maxTokens: 4_000_000, gate: '   ' },
  }), /ARC_AUTONOMOUS_CHANGED/)
  await assert.rejects(() => __test.normalizeConfig({
    ...qualityStart('S'),
    route: { ...fixture.base.route, model: 'other-model' },
  }), /ARC_ROUTE_CHANGED/)

  const recoveryStart = () => ({
    ...fixture.base,
    protocol: 'quality-recovery-v1',
    arm: 'S',
    requestLimit: 11,
    wallTimeMs: 1_200_000,
    autonomous: { maxTurns: 11, maxTokens: 4_000_000, gate: 'test -f answer.json' },
  })
  const recovery = await __test.normalizeConfig(recoveryStart())
  assert.equal(recovery.protocol, 'quality-recovery-v1')
  assert.equal(recovery.arm, 'S')
  assert.equal(recovery.nativeDepth, 1)
  assert.equal(recovery.requestLimit, 11)
  assert.equal(recovery.wallTimeMs, 1_200_000)
  assert.deepEqual(recovery.autonomous, { maxTurns: 11, maxTokens: 4_000_000, gate: 'test -f answer.json' })
  assert.equal(recovery.brokerSocket, undefined)
  assert.equal(recovery.brokerState, undefined)
  assert.equal(__test.defaultNativeDepth('quality-recovery-v1', 'S'), 1)
  await assert.rejects(() => __test.normalizeConfig({ ...recoveryStart(), requestLimit: 10 }), /ARC_REQUEST_LIMIT_CHANGED/)
  await assert.rejects(() => __test.normalizeConfig({ ...recoveryStart(), requestLimit: 12 }), /ARC_REQUEST_LIMIT_CHANGED/)
  await assert.rejects(() => __test.normalizeConfig({ ...recoveryStart(), arm: 'R' }), /ARC_WORKER_CONFIG/)

  const recursionStart = arm => ({
    ...fixture.base,
    protocol: 'recursion-ablation-v1',
    arm,
    requestLimit: 14,
    wallTimeMs: 1_200_000,
    autonomous: { maxTurns: 14, maxTokens: 4_000_000, gate: 'test -f answer.json' },
  })
  const s0 = await __test.normalizeConfig(recursionStart('S0'))
  const s = await __test.normalizeConfig(recursionStart('S'))
  assert.equal(s0.nativeDepth, 0)
  assert.equal(s.nativeDepth, 1)
  assert.equal(s0.label, s.label)
  assert.equal(s0.brokerSocket, undefined)
  assert.equal(s0.brokerState, undefined)
  assert.deepEqual(sameRecursionConfig(s0), sameRecursionConfig(s))

  await assert.rejects(() => __test.normalizeConfig({
    ...recursionStart('S0'),
    route: { ...fixture.base.route, provider: 'other-provider' },
  }), /ARC_ROUTE_CHANGED/)
  await assert.rejects(() => __test.normalizeConfig({ ...recursionStart('S0'), requestLimit: 32 }), /ARC_REQUEST_LIMIT_CHANGED/)
  await assert.rejects(() => __test.normalizeConfig({ ...recursionStart('R') }), /ARC_WORKER_CONFIG/)
  await assert.rejects(() => __test.normalizeConfig({ ...recursionStart('S0'), wallTimeMs: 3_600_000 }), /ARC_WALL_TIME_CHANGED/)
  await assert.rejects(() => __test.normalizeConfig({
    ...recursionStart('S0'),
    autonomous: { maxTurns: 14, maxTokens: 4_000_000, gate: '   ' },
  }), /ARC_AUTONOMOUS_CHANGED/)
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
  testImportedWorkerDoesNotListenForIpc()
  await testConfigModes()
  const sandbox = await testSandbox()
  process.stdout.write(`${JSON.stringify({ status: 'passed', sandboxRoot: sandbox.root, sandbox: sandbox.result })}\n`)
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error.message}\n`)
  process.exitCode = 1
})
