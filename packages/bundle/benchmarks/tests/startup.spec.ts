/**
 * The benchmark command-line provider over a real Loader tree: a valid
 * invocation becomes the `benchStartup` service, while help, usage errors,
 * and a source launch leave it unprovided with an exit code.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, BENCH_STARTUP_SERVICE, resolveLauncher, type BenchStartupValues } from '../src/startup.ts'

const disposers: (() => Promise<void>)[] = []
const realArgv = process.argv

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  internals.stdout = process.stdout
  internals.stderr = process.stderr
  process.argv = realArgv
})

async function boot(args: string[], script = '/opt/dsh/lib/bin.js'): Promise<{ values: BenchStartupValues | undefined; exits: number[]; out: string }> {
  process.argv = [process.execPath, script]
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bench-startup-'))
  writeFileSync(join(dir, 'startup.mjs'), `
export const name = 'bench-startup'
export const inject = ['cmdlineArgs']
export const apply = ctx => globalThis.__benchStartupApply(ctx)
`)
  writeFileSync(join(dir, 'cordis.yml'), `- id: bench-startup\n  name: ${pathToFileURL(join(dir, 'startup.mjs')).href}\n`)
  ;(globalThis as unknown as { __benchStartupApply: typeof apply }).__benchStartupApply = apply
  let out = ''
  const observing = { write: (chunk: string) => { out += chunk; return true } }
  internals.stdout = observing
  internals.stderr = observing
  const exits: number[] = []
  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  provideCmdline(ctx, { args, exit: code => void exits.push(code) })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  disposers.push(async () => { await ctx.fiber.dispose() })
  return { values: ctx.get(BENCH_STARTUP_SERVICE) as BenchStartupValues | undefined, exits, out }
}

describe('resolveLauncher', () => {
  it('re-executes a built script and refuses anything else', () => {
    expect(resolveLauncher('/usr/bin/node', ['/usr/bin/node', '/opt/dsh/lib/bin.js', 'x'])).toEqual(['/usr/bin/node', '/opt/dsh/lib/bin.js'])
    expect(() => resolveLauncher('/usr/bin/node', ['/usr/bin/node', '/repo/apps/cli/src/bin.ts'])).toThrow(/must run from the built CLI \(got "\/repo\/apps\/cli\/src\/bin\.ts"\)/)
    expect(() => resolveLauncher('/usr/bin/node', ['/usr/bin/node'])).toThrow(/got ""/)
  })
})

describe('bench-startup', () => {
  it('provides the experiment, confirmation, ceiling, and launcher', async () => {
    const { values, exits } = await boot(['exp.yml', '--yes', '--max-usd', '1.5'])
    expect(exits).toEqual([])
    expect(values).toEqual({ experiment: resolve('exp.yml'), confirmed: true, maxUsd: 1.5, launcher: [process.execPath, '/opt/dsh/lib/bin.js'] })
  })

  it('defaults to unconfirmed with no ceiling', async () => {
    expect((await boot(['exp.yml'])).values).toEqual({ experiment: resolve('exp.yml'), confirmed: false, launcher: [process.execPath, '/opt/dsh/lib/bin.js'] })
  })

  it.each([
    [[], /missing required argument 'experiment'/],
    [['exp.yml', '--max-usd', '0'], /expected a positive number of US dollars/],
    [['exp.yml', '--max-usd', 'lots'], /expected a positive number of US dollars/],
  ])('rejects %j without providing the service', async (args, message) => {
    const { values, exits, out } = await boot(args)
    expect(values).toBeUndefined()
    expect(exits).toEqual([1])
    expect(out).toMatch(message)
  })

  it('refuses a source launch', async () => {
    const { values, exits, out } = await boot(['exp.yml'], '/repo/apps/cli/src/bin.ts')
    expect(values).toBeUndefined()
    expect(exits).toEqual([1])
    expect(out).toContain('must run from the built CLI')
  })

  it('prints help and exits 0', async () => {
    const { values, exits, out } = await boot(['--help'])
    expect(values).toBeUndefined()
    expect(exits).toEqual([0])
    expect(out).toContain('--max-usd <amount>')
  })
})
