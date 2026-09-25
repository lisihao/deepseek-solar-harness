/** Local administrative CLI for authenticated Server/Frontend pairing. */

import { randomUUID } from 'node:crypto'
import { Command, CommanderError } from 'commander'

interface PairOptions {
  endpoint: string
  scope: string
  publicUrl?: string
}

/** Execute one remote-device command without booting another Host. */
export async function runRemoteCommand(args: readonly string[]): Promise<number> {
  let operation: (() => Promise<void>) | undefined
  const program = new Command()
    .name('dsh remote')
    .exitOverride()
    .showHelpAfterError()
  program.command('pair')
    .description('issue a one-time pairing code from a running local Server')
    .option('--endpoint <url>', 'loopback Server URL', 'http://127.0.0.1:3080')
    .option('--scope <scope>', 'device scope: cockpit, pocket, or admin', 'pocket')
    .option('--public-url <url>', 'HTTPS URL the remote device should open')
    .action((options: PairOptions) => {
      operation = () => issuePairing(options)
    })
  try {
    program.parse([...args], { from: 'user' })
    if (operation === undefined) throw new Error('dsh remote: no command selected')
    await operation()
    return 0
  } catch (error) {
    if (!(error instanceof CommanderError)) {
      process.stderr.write(`dsh remote: ${error instanceof Error ? error.message : String(error)}\n`)
    }
    return 1
  }
}

async function issuePairing(options: PairOptions): Promise<void> {
  if (options.scope !== 'cockpit' && options.scope !== 'pocket' && options.scope !== 'admin') {
    throw new Error(`invalid scope ${JSON.stringify(options.scope)}`)
  }
  const endpoint = loopbackEndpoint(options.endpoint)
  const publicUrl = options.publicUrl === undefined ? undefined : new URL(options.publicUrl)
  if (publicUrl !== undefined && publicUrl.protocol !== 'https:') throw new Error('--public-url must use HTTPS')
  const rpcId = randomUUID()
  const response = await fetch(new URL('/remote-auth/pairing.issue', endpoint), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request', rpcId, method: 'pairing.issue', payload: { scope: options.scope },
    }),
  })
  if (!response.ok) throw new Error(`pairing request failed: HTTP ${String(response.status)}`)
  const envelope = objectRecord(await response.json(), 'pairing response')
  if (envelope.rpcId !== rpcId) throw new Error('pairing response rpcId mismatch')
  const result = objectRecord(envelope.result, 'pairing result')
  if (result.ok !== true) throw new Error('pairing request was rejected')
  const value = objectRecord(result.value, 'pairing value')
  if (typeof value.code !== 'string' || typeof value.expiresAt !== 'string') {
    throw new Error('pairing response is invalid')
  }
  process.stdout.write(`Pairing code: ${value.code}\nScope: ${options.scope}\nExpires: ${value.expiresAt}\n`)
  if (publicUrl !== undefined) {
    publicUrl.searchParams.set('dsh-deployment-role', 'frontend')
    process.stdout.write(`Open: ${publicUrl.href}\n`)
  }
}

function loopbackEndpoint(input: string): URL {
  const endpoint = new URL(input)
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw new Error('--endpoint must use HTTP or HTTPS')
  }
  if (endpoint.hostname !== '127.0.0.1' && endpoint.hostname !== 'localhost' && endpoint.hostname !== '[::1]') {
    throw new Error('--endpoint must be loopback; pairing issuance is local-only')
  }
  if (endpoint.username !== '' || endpoint.password !== '' || endpoint.pathname !== '/'
    || endpoint.search !== '' || endpoint.hash !== '') {
    throw new Error('--endpoint must contain only loopback scheme and authority')
  }
  return endpoint
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}
