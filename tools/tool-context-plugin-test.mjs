import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
const scratch = await mkdtemp(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'solar-tool-context-'))
const marker = join(scratch, 'receipt.json')
const dshHome = join(scratch, 'dsh')
const home = join(scratch, 'home')
const profile = 'tool-context-keyless'
const cli = join(root, 'node_modules/.bin/dsh')
const probe = join(root, 'tools/fixtures/tool-context-probe')

// Deliberately allowlist the environment. The scratch profile has no provider
// credentials and the probe mounts only its isolated fake adapter/substrate.
const env = {
  PATH: process.env.PATH, LANG: process.env.LANG ?? 'en_US.UTF-8',
  HOME: home, DSH_HOME: dshHome, TERM: 'dumb', NO_COLOR: '1',
  SOLAR_TOOL_CONTEXT_PROBE_MARKER: marker,
  SOLAR_TOOL_CONTEXT_PROBE_EXIT: '1',
  ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
}

function command(args, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, timeoutMs)
    const collect = chunk => { output = (output + String(chunk)).slice(-128 * 1024) }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (code !== 0 || timedOut || signal) reject(new Error(`tool-context scratch command ${JSON.stringify(args)} failed (${code ?? signal}, timeout=${timedOut}):\n${output}`))
      else resolve(output)
    })
  })
}

let passed = false
try {
  await mkdir(home, { recursive: true })
  await build({
    absWorkingDir: probe, entryPoints: ['src/index.ts'], outdir: 'lib',
    bundle: true, packages: 'external', platform: 'node', target: 'node22', format: 'esm',
  })
  for (const directory of [join(root, 'incubator/tool-context'), probe]) {
    // A tarball tests the actual installed module resolution; a file-linked
    // probe would resolve imports from the source checkout instead of profile.
    const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', scratch], { cwd: directory, env, encoding: 'utf8' }))
    await command(['plugin', '--profile', profile, 'add', join(scratch, packed[0].filename)])
  }
  const manifest = JSON.parse(await readFile(join(dshHome, 'profiles', profile, 'package.json'), 'utf8'))
  for (const name of ['@lisihao/dsh-solar-tool-context', '@lisihao/dsh-solar-tool-context-probe']) {
    if (!manifest.dsh?.profile?.bundles?.includes(name)) throw new Error(`scratch profile is missing enabled bundle ${name}`)
  }
  await command(['--profile', profile], 90_000)
  const receipt = JSON.parse(await readFile(marker, 'utf8'))
  if (receipt.ok !== true || receipt.keyless !== true || receipt.isolated !== true || receipt.realProviderCalls !== 0 || receipt.userSessionWrites !== 0) throw new Error(`scratch acceptance failed: ${JSON.stringify(receipt)}`)
  process.stdout.write(`${JSON.stringify({ profile, receipt }, null, 2)}\n`)
  passed = true
} finally {
  if (passed) await rm(scratch, { recursive: true, force: true })
  else process.stderr.write(`tool-context scratch evidence preserved at ${scratch}\n`)
}
