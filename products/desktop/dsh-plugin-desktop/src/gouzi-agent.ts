/**
 * Command line a main instance runs over SSH on a remote machine to manage Gouzi members there. Each invocation
 * performs one operation and prints one result line, so the main instance needs no long-lived remote process of
 * its own: the members are detached and outlive every invocation.
 */

import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { GouziFolderListing, GouziProjectSource, GouziProvisionInput } from '@deepseek-ai/dsh-ui-gouzi'
import { LocalGouziOperations, type LocalGouziConfig, type LocalGouziStarted } from './gouzi-local.ts'

/** Wire version of the agent protocol; a main instance refuses an agent that reports another. */
export const GOUZI_AGENT_PROTOCOL = 2

/** Prefix of the result line. The login shell may print banners before it, so a reader searches for this prefix. */
export const GOUZI_AGENT_RESULT_PREFIX = 'DSH-GOUZI-AGENT '

/** Facts a remote machine reports about itself. */
export interface GouziAgentProbe {
  readonly protocol: number
  /** Version of the installed DSH Desktop. */
  readonly appVersion: string
  readonly platform: string
  readonly arch: string
  /** Directory that holds the remote members' homes. */
  readonly membersRoot: string
  readonly home: string
}

/** Result line of one invocation. */
export type GouziAgentResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string; readonly code?: string }

/** What the agent needs from its host process. */
export interface GouziAgentEnvironment {
  readonly appVersion: string
  readonly operations: LocalGouziOperationsLike
  readonly membersRoot: string
  readonly home: string
}

/** The operations the agent calls; a test may substitute a recording implementation. */
export interface LocalGouziOperationsLike {
  resolveRepository(path: string): Promise<GouziProjectSource>
  prepareRepository(path: string): Promise<GouziProjectSource>
  provision(input: GouziProvisionInput): Promise<void>
  start(gouziId: string): Promise<LocalGouziStarted>
  stop(gouziId: string, options?: { readonly reclaimResident?: boolean }): Promise<{ readonly processTreeStopped: boolean }>
  browse(path?: string): GouziFolderListing
}

const MEMBER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u

function requireOption(argv: readonly string[], flag: string): string {
  const index = argv.indexOf(flag)
  const value = index < 0 ? undefined : argv[index + 1]
  if (value === undefined) throw new Error(`${flag} is required`)
  return value
}

function optionalOption(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  return index < 0 ? undefined : argv[index + 1]
}

function memberId(argv: readonly string[]): string {
  const id = requireOption(argv, '--id')
  if (!MEMBER_ID_PATTERN.test(id)) throw new Error(`member id "${id}" is not valid`)
  return id
}

/**
 * Run one agent operation.
 * @param argv - the operation name followed by its flags, for example `start --id gouzi-1`.
 * @param stdin - request body of operations that take one, for example the provisioning JSON of `provision`.
 * @param environment - the host process facts and member operations.
 * @returns the operation result.
 * @throws Error - when the operation is unknown or its inputs are invalid.
 */
export async function runGouziAgent(
  argv: readonly string[],
  stdin: string,
  environment: GouziAgentEnvironment,
): Promise<unknown> {
  const [operation, ...flags] = argv
  switch (operation) {
    case 'probe':
      return {
        protocol: GOUZI_AGENT_PROTOCOL,
        appVersion: environment.appVersion,
        platform: process.platform,
        arch: process.arch,
        membersRoot: environment.membersRoot,
        home: environment.home,
      } satisfies GouziAgentProbe
    case 'resolve': return environment.operations.resolveRepository(requireOption(flags, '--path'))
    case 'prepare': return environment.operations.prepareRepository(requireOption(flags, '--path'))
    case 'browse': return environment.operations.browse(optionalOption(flags, '--path'))
    case 'provision': {
      await environment.operations.provision(JSON.parse(stdin) as GouziProvisionInput)
      return {}
    }
    case 'start': return environment.operations.start(memberId(flags))
    case 'stop': return environment.operations.stop(memberId(flags), { reclaimResident: flags.includes('--reclaim') })
    default: throw new Error(`unknown operation ${String(operation)}`)
  }
}

/**
 * Settings of the remote members; a separate directory keeps them apart from the members of a main instance that
 * runs on the same machine.
 * @param home - the DSH home of this machine.
 * @param workerScript - launcher of one member.
 * @returns the member operations configuration.
 */
export function remoteMembersConfig(home: string, workerScript: string | undefined): LocalGouziConfig {
  return {
    membersRoot: join(home, 'gouzi', 'remote-members'),
    activeLimit: Number(process.env.DSH_GOUZI_ACTIVE_LIMIT ?? 2),
    readyTimeoutMs: 120_000,
    stopTimeoutMs: 20_000,
    gitTimeoutMs: 10_000,
    ...workerScript === undefined ? {} : { workerScript },
    nodeArgs: [],
  }
}

/**
 * Entry of the agent executable: read stdin, run the operation, print the result line.
 * @param argv - arguments after the executable.
 * @param appVersion - version of the installed DSH Desktop.
 * @param readStdin - reads the whole of standard input.
 * @param write - writes to standard output.
 * @param worker - launcher override of one member, for a source checkout that has no built `lib/`.
 */
export async function main(
  argv: readonly string[],
  appVersion: string,
  readStdin: () => Promise<string>,
  write: (text: string) => void,
  worker: { readonly workerScript?: string; readonly nodeArgs?: readonly string[] } = {},
): Promise<void> {
  const home = resolveDshHome()
  const config: LocalGouziConfig = { ...remoteMembersConfig(home, worker.workerScript), nodeArgs: worker.nodeArgs ?? [] }
  let result: GouziAgentResult
  try {
    // Only operations that take a body read stdin; reading it for the others would wait on an inherited terminal.
    const stdin = argv[0] === 'provision' ? await readStdin() : ''
    const value = await runGouziAgent(argv, stdin, {
      appVersion,
      operations: new LocalGouziOperations(config),
      membersRoot: config.membersRoot,
      home,
    })
    result = { ok: true, value }
  } catch (cause) {
    const code = cause instanceof Error ? (cause as NodeJS.ErrnoException).code : undefined
    result = { ok: false, message: cause instanceof Error ? cause.message : String(cause), ...typeof code === 'string' ? { code } : {} }
  }
  write(`${GOUZI_AGENT_RESULT_PREFIX}${JSON.stringify(result)}\n`)
}
