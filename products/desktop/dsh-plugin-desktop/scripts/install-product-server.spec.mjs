import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseInstallerArguments,
  renderProductServerLaunchAgent,
  renderProductServerCluster,
  validateProductServerDescription,
} from './install-product-server.mjs'

const commit = '1234567890abcdef1234567890abcdef12345678'

test('requires a stable Desktop tag pinned to one exact commit', () => {
  const options = parseInstallerArguments([
    '--ref', 'DSH-desktop-v3.9.0', '--commit', commit, '--port', '13080', '--host', '127.0.0.1',
  ])
  assert.equal(options.ref, 'DSH-desktop-v3.9.0')
  assert.equal(options.commit, commit)
  assert.equal(options.port, 13080)
  assert.equal(options.host, '127.0.0.1')
  assert.equal(options.executionRepository, 'https://github.com/lisihao/deepseek-solar-harness.git')
  assert.throws(() => parseInstallerArguments(['--ref', 'main', '--commit', commit]), /stable/)
  assert.throws(() => parseInstallerArguments(['--ref', 'DSH-desktop-v3.9.0', '--commit', 'short']), /40-character/)
})

test('renders a standalone remote-execution cluster from the GitHub authority', () => {
  const cluster = JSON.parse(renderProductServerCluster({
    endpoint: 'http://127.0.0.1:13080/',
    executionRepository: 'https://github.com/lisihao/deepseek-solar-harness.git',
  }))
  assert.equal(cluster.nodeId, 'product-server-local')
  assert.equal(cluster.members[0].remoteExecution.repositories[0].repository, 'github.com/lisihao/deepseek-solar-harness')
  assert.equal(cluster.members[0].remoteExecution.repositories[0].source, 'https://github.com/lisihao/deepseek-solar-harness.git')
})

test('renders an owner LaunchAgent without copying a MacBook artifact', () => {
  const plist = renderProductServerLaunchAgent({
    label: 'ai.deepseek.dsh.product-server',
    nodePath: '/opt/node/bin/node',
    currentPath: '/Users/test/Library/Application Support/DSH Product Server/current',
    dshHome: '/Users/test/.dsh-product-server',
    commit,
    host: '127.0.0.1',
    port: 13080,
    path: '/opt/node/bin:/usr/bin:/bin',
    stdoutPath: '/tmp/dsh-out.log',
    stderrPath: '/tmp/dsh-err.log',
  })
  assert.match(plist, /product-server-bin\.js/)
  assert.match(plist, /DSH_BUILD_COMMIT/)
  assert.match(plist, new RegExp(commit))
  assert.doesNotMatch(plist, /DSH Desktop\.app/)
})

test('accepts only a running Remote Sync surface with resident operator capabilities', () => {
  const description = {
    protocol: { major: 1, minor: 4 },
    capabilities: [
      'operator.read', 'operator.execute', 'operator.interrupt',
      'operator.workspace.materialize', 'operator.artifact.read',
    ],
  }
  assert.doesNotThrow(() => validateProductServerDescription(description, [{ operatorId: 'codex' }]))
  assert.throws(
    () => validateProductServerDescription({ capabilities: ['operator.read'] }, [{ operatorId: 'codex' }]),
    /operator.execute/,
  )
  assert.throws(() => validateProductServerDescription(description, []), /no resident providers/)
  assert.throws(() => validateProductServerDescription({ ...description, protocol: { major: 1, minor: 3 } }, [{}]), /1\.4/)
})
