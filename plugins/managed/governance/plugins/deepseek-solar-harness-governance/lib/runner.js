import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export async function sha256File(path) {
  return sha256(await readFile(path))
}

export function extractLastJsonObject(output) {
  const trimmed = output.trim()
  for (let index = trimmed.lastIndexOf('{'); index >= 0; index = trimmed.lastIndexOf('{', index - 1)) {
    try {
      return JSON.parse(trimmed.slice(index))
    } catch {
      // Gate output may contain braces. Keep looking for the final root object.
    }
  }
  throw new Error('governance process did not emit a final JSON object')
}

export function runArgv(argv, options = {}) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some(value => typeof value !== 'string')) {
    throw new TypeError('argv must be a non-empty string array')
  }
  const timeoutMs = options.timeoutMs ?? 1_800_000
  const maxOutputBytes = options.maxOutputBytes ?? 4 * 1024 * 1024
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let timedOut = false
    let overflow = false
    const append = (current, chunk) => {
      const next = Buffer.concat([current, chunk])
      if (next.length <= maxOutputBytes) return next
      overflow = true
      child.kill('SIGTERM')
      return next.subarray(0, maxOutputBytes)
    }
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk) })
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk) })
    child.on('error', reject)
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 1_000).unref()
    }, timeoutMs)
    timer.unref()
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({
        argv: [...argv],
        code,
        signal,
        timedOut,
        overflow,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        outputSha256: sha256(Buffer.concat([stdout, stderr])),
      })
    })
  })
}

export function governanceArgv(config, command, project, extra = []) {
  return [
    config.python,
    config.corePath,
    command,
    '--project',
    project,
    ...(config.profilePath === null ? [] : ['--profile', config.profilePath]),
    '--json',
    ...extra,
  ]
}

export async function runGovernance(config, command, project, extra = []) {
  const argv = governanceArgv(config, command, project, extra)
  const result = await runArgv(argv, {
    cwd: project,
    timeoutMs: config.timeoutMs,
    maxOutputBytes: config.maxOutputBytes,
  })
  const combined = `${result.stdout}\n${result.stderr}`
  let payload = null
  try {
    payload = extractLastJsonObject(combined)
  } catch (error) {
    if (result.code === 0) throw error
  }
  return { ...result, payload }
}

export function runGovernanceSync(config, command, project, extra = []) {
  const argv = governanceArgv(config, command, project, extra)
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: project,
    env: process.env,
    shell: false,
    encoding: 'utf8',
    timeout: config.syncTimeoutMs,
    maxBuffer: config.maxOutputBytes,
  })
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  let payload = null
  try {
    payload = extractLastJsonObject(combined)
  } catch {
    // The caller treats an absent payload as a fail-closed result.
  }
  return {
    argv,
    code: result.status,
    signal: result.signal,
    timedOut: result.error?.code === 'ETIMEDOUT',
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    payload,
  }
}

export async function gitMetadataPath(project) {
  const result = await runArgv(
    ['git', 'rev-parse', '--path-format=absolute', '--git-path', 'governance-attestation.json'],
    { cwd: project, timeoutMs: 10_000, maxOutputBytes: 64 * 1024 },
  )
  if (result.code !== 0) throw new Error(`cannot resolve Git attestation path: ${result.stderr.trim()}`)
  return result.stdout.trim()
}
