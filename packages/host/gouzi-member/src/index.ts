/** File-backed Provider of the Gouzi execution-member gate. */

import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  GouziAdmissionError,
  GouziMemberService,
  type GouziAdmission,
  type GouziMemberHello,
  type RemoteResidentAcceptedTurn,
} from '@deepseek-ai/dsh-client-connection'
import type { GouziExecutionGrant } from '@deepseek-ai/dsh-orchestration'

/** Gate configuration. */
export interface Config {
  /** Absolute state root of this member; `gouzi/identity.json` and `gouzi/ledger.json` live under it. */
  stateRoot: string
}

/** The identity a member host stores when the main instance provisions it. */
export interface GouziStoredIdentity {
  readonly version: 1
  readonly gouziId: string
  readonly ownerId: string
  readonly hostId: string
  readonly generation: number
  readonly authorityEpoch: string
  readonly createdAt: string
}

interface LedgerEntry {
  readonly requestHash: string
  readonly admittedAt: string
  accepted?: RemoteResidentAcceptedTurn
}

interface LedgerDocument {
  readonly version: 1
  incarnation: number
  readonly executions: Record<string, LedgerEntry>
}

const IDENTITY_FILE = 'identity.json'
const LEDGER_FILE = 'ledger.json'

function memberDirectory(stateRoot: string): string {
  return join(resolve(stateRoot), 'gouzi')
}

/**
 * Store the identity of a new member. An existing identity is never replaced: re-pairing mints a new epoch through
 * an explicit later operation, not by overwriting this file.
 * @param stateRoot - the member's state root.
 * @param identity - identity and epoch minted by the main instance.
 * @throws Error - when a different identity is already stored.
 */
export async function provisionGouziIdentity(
  stateRoot: string,
  identity: Omit<GouziStoredIdentity, 'version' | 'createdAt'>,
): Promise<void> {
  const directory = memberDirectory(stateRoot)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const filename = join(directory, IDENTITY_FILE)
  const stored: GouziStoredIdentity = { version: 1, createdAt: new Date().toISOString(), ...identity }
  const existing = await readIdentity(filename)
  if (existing !== undefined) {
    const same = existing.gouziId === identity.gouziId && existing.ownerId === identity.ownerId
      && existing.hostId === identity.hostId && existing.generation === identity.generation
      && existing.authorityEpoch === identity.authorityEpoch
    if (!same) throw new Error(`gouzi-member: ${filename} already holds a different identity`)
    return
  }
  await writeFileAtomic(filename, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
}

async function readIdentity(filename: string): Promise<GouziStoredIdentity | undefined> {
  let text: string
  try {
    text = await readFile(filename, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const value = JSON.parse(text) as Partial<GouziStoredIdentity>
  if (value.version !== 1 || typeof value.gouziId !== 'string' || typeof value.ownerId !== 'string'
    || typeof value.hostId !== 'string' || !Number.isSafeInteger(value.generation)
    || typeof value.authorityEpoch !== 'string' || typeof value.createdAt !== 'string') {
    throw new Error(`gouzi-member: ${filename} is not a version 1 identity document`)
  }
  return value as GouziStoredIdentity
}

/** Sole writer of one member's stored identity use and execution ledger. */
export default class GouziMemberHost extends GouziMemberService {
  static Config: z<Config> = z.object({ stateRoot: z.string().required() })

  private identity!: GouziStoredIdentity
  private ledger!: LedgerDocument
  private readonly ledgerFile: string
  private readonly identityFile: string
  private writes: Promise<void> = Promise.resolve()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    const directory = memberDirectory(config.stateRoot)
    this.identityFile = join(directory, IDENTITY_FILE)
    this.ledgerFile = join(directory, LEDGER_FILE)
  }

  async [GouziMemberService.init](): Promise<void> {
    const identity = await readIdentity(this.identityFile)
    if (identity === undefined) {
      throw new Error(`gouzi-member: no identity at ${this.identityFile}; the main instance must provision this member first`)
    }
    this.identity = identity
    this.ledger = await this.loadLedger()
    this.ledger.incarnation += 1
    await this.persist()
  }

  override hello(): GouziMemberHello {
    const { gouziId, ownerId, hostId, generation, authorityEpoch } = this.identity
    return { gouziId, ownerId, hostId, generation, authorityEpoch, incarnation: this.ledger.incarnation }
  }

  override admit(grant: GouziExecutionGrant, requestHash: string, now: number): Promise<GouziAdmission> {
    return this.serialized(async () => {
      if (String(grant.gouziId) !== this.identity.gouziId) {
        throw new GouziAdmissionError('GOUZI_IDENTITY_MISMATCH', 'the grant names another member')
      }
      if (grant.generation !== this.identity.generation) {
        throw new GouziAdmissionError('GOUZI_GENERATION_MISMATCH', 'the grant belongs to another generation of this member')
      }
      if (String(grant.authorityEpoch) !== this.identity.authorityEpoch) {
        throw new GouziAdmissionError('GOUZI_EPOCH_MISMATCH', 'the grant was issued under another authority epoch')
      }
      if (grant.planHash !== requestHash) {
        throw new GouziAdmissionError('GOUZI_PLAN_MISMATCH', 'the request differs from the sealed plan')
      }
      const key = String(grant.executionId)
      const entry = this.ledger.executions[key]
      if (entry !== undefined) {
        if (entry.requestHash !== requestHash) {
          throw new GouziAdmissionError('GOUZI_EXECUTION_CONFLICT', 'the execution id was used for another request')
        }
        return entry.accepted === undefined ? { kind: 'new' } : { kind: 'replay', accepted: entry.accepted }
      }
      if (!(Date.parse(grant.deadline) > now)) {
        throw new GouziAdmissionError('GOUZI_GRANT_EXPIRED', 'the grant deadline has passed')
      }
      this.ledger.executions[key] = { requestHash, admittedAt: new Date(now).toISOString() }
      await this.persist()
      return { kind: 'new' }
    })
  }

  override recordAccepted(executionId: string, accepted: RemoteResidentAcceptedTurn): Promise<void> {
    return this.serialized(async () => {
      const entry = this.ledger.executions[executionId]
      if (entry === undefined) throw new Error(`gouzi-member: execution ${executionId} was never admitted`)
      entry.accepted = accepted
      await this.persist()
    })
  }

  private async loadLedger(): Promise<LedgerDocument> {
    let text: string
    try {
      text = await readFile(this.ledgerFile, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, incarnation: 0, executions: {} }
      throw error
    }
    const value = JSON.parse(text) as Partial<LedgerDocument>
    const executions: unknown = value.executions
    if (value.version !== 1 || !Number.isSafeInteger(value.incarnation)
      || executions === null || typeof executions !== 'object') {
      throw new Error(`gouzi-member: ${this.ledgerFile} is not a version 1 ledger`)
    }
    return value as LedgerDocument
  }

  private persist(): Promise<void> {
    return writeFileAtomic(this.ledgerFile, `${JSON.stringify(this.ledger)}\n`, { mode: 0o600, dirMode: 0o700 })
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(operation)
    this.writes = result.then(() => undefined, () => undefined)
    return result
  }
}
