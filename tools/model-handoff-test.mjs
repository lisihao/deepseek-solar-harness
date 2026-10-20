import { spawn } from 'node:child_process'
import { mkdtemp, readFile, mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = fileURLToPath(new URL('../', import.meta.url))
const scratch = await mkdtemp(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'dsh-handoff-plugin-'))
const marker = join(scratch, 'probe.json')
const profile = 'model-handoff-test'
const env = { ...process.env }
for (const key of Object.keys(env)) {
  if (key.startsWith('DSH_') || /TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|AUTH|PROXY/i.test(key) || /^(?:OPENAI|ANTHROPIC|DEEPSEEK|CODEX|CLAUDE)_/.test(key)) delete env[key]
}
Object.assign(env, { HOME: join(scratch, 'home'), DSH_HOME: scratch, DSH_TELEMETRY_DISABLED: '1', SOLAR_HANDOFF_MARKER: marker })
await mkdir(env.HOME, { recursive: true })
const cli = join(root, 'node_modules/.bin/dsh')
async function run(args) {
  const child = spawn(cli, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', data => { output = (output + data).slice(-16000) })
  child.stderr.on('data', data => { output = (output + data).slice(-16000) })
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`Timeout: ${output}`)) }, 90000)
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('close', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`CLI exit ${code}: ${output}`)) })
  })
}
try {
  for (const directory of ['incubator/model-handoff', 'tools/fixtures/handoff-probe']) {
    await run(['plugin', '--profile', profile, 'add', join(root, directory), '--prefer-offline'])
  }
  await run(['--profile', profile])
  const result = JSON.parse(await readFile(marker, 'utf8'))
  if (!result.ok) throw new Error(JSON.stringify(result))
  console.log(JSON.stringify({ profile, runtime: 'built lib / plain Node / official CLI', ...result }, null, 2))
  await rm(scratch, { recursive: true, force: true })
} catch (error) {
  console.error('Scratch evidence retained:', scratch)
  throw error
}
