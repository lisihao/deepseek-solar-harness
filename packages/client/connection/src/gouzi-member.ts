/** Member-side gate for one Gouzi execution host: identity, grant admission, and the idempotency ledger. */

import { createHash } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { GouziExecutionGrant } from '@deepseek-ai/dsh-orchestration'
import type { RemoteResidentAcceptedTurn, RemoteResidentExecuteRequest } from './remote-sync.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    gouziMember: GouziMemberService
  }
}

/** What a member host says about itself; contains no secret. */
export interface GouziMemberHello {
  readonly gouziId: string
  readonly ownerId: string
  readonly hostId: string
  readonly generation: number
  readonly authorityEpoch: string
  /** Increases at every member process start so a restart is observable. */
  readonly incarnation: number
}

/** Result of presenting a grant before any workspace or Resident effect. */
export type GouziAdmission =
  | { readonly kind: 'new' }
  | { readonly kind: 'replay'; readonly accepted: RemoteResidentAcceptedTurn }

/** Why a member refused a grant. */
export type GouziAdmissionCode =
  | 'GOUZI_IDENTITY_MISMATCH'
  | 'GOUZI_GENERATION_MISMATCH'
  | 'GOUZI_EPOCH_MISMATCH'
  | 'GOUZI_PLAN_MISMATCH'
  | 'GOUZI_EXECUTION_MISMATCH'
  | 'GOUZI_GRANT_EXPIRED'
  | 'GOUZI_EXECUTION_CONFLICT'

/** Refusal raised before any side effect; the HTTP status is 409 for a conflicting repeat and 403 otherwise. */
export class GouziAdmissionError extends Error {
  constructor(readonly code: GouziAdmissionCode, message: string) {
    super(message)
    this.name = 'GouziAdmissionError'
  }
}

/**
 * Server-local Provider seam for one execution member. The connection package is the wire Consumer; the member
 * process mounts exactly one Provider. A host without it refuses every `gouzi`-scope execution.
 */
export abstract class GouziMemberService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'gouziMember')
  }

  /**
   * Report the member identity the host stored at provisioning.
   * @returns identity and incarnation.
   */
  abstract hello(): GouziMemberHello

  /**
   * Check a grant against the stored identity and the request hash, then consult the idempotency ledger. Must run
   * before the workspace is materialized or any Resident turn starts.
   * @param grant - the sealed authorization sent with the request.
   * @param requestHash - {@link gouziRequestHash} of the request actually received.
   * @param now - current time in epoch milliseconds, injected for deterministic deadline checks.
   * @returns `new` when the execution may start, or the stored accepted receipt for a repeat.
   * @throws GouziAdmissionError - when the grant does not authorize this request.
   */
  abstract admit(grant: GouziExecutionGrant, requestHash: string, now: number): Promise<GouziAdmission>

  /**
   * Store the accepted receipt so a repeated execution id returns it unchanged.
   * @param executionId - the admitted execution id.
   * @param accepted - the receipt returned to the main instance.
   */
  abstract recordAccepted(executionId: string, accepted: RemoteResidentAcceptedTurn): Promise<void>
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).filter(key => record[key] !== undefined).sort()
      .map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Hash everything an execution request asks the member to do. `commandId` is excluded because the grant names the
 * execution id separately; the hash therefore also serves as the grant's sealed plan hash.
 * @param request - the Resident execution request as sent over Remote Sync.
 * @returns lowercase SHA-256 hexadecimal.
 */
export function gouziRequestHash(request: RemoteResidentExecuteRequest): string {
  const { commandId: _commandId, ...plan } = request
  return createHash('sha256').update(canonical(plan)).digest('hex')
}

/**
 * Parse the grant a main instance attaches to `operator.execute`.
 * @param value - untrusted JSON from the request body.
 * @returns the grant.
 * @throws Error - when a field is missing or has the wrong type.
 */
export function parseGouziGrant(value: unknown): GouziExecutionGrant {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('gouziGrant must be an object')
  const record = value as Record<string, unknown>
  const text = (key: string): string => {
    const field = record[key]
    if (typeof field !== 'string' || field.length === 0) throw new Error(`gouziGrant.${key} must be a non-empty string`)
    return field
  }
  const integer = (key: string): number => {
    const field = record[key]
    if (!Number.isSafeInteger(field) || (field as number) < 0) throw new Error(`gouziGrant.${key} must be a non-negative integer`)
    return field as number
  }
  const strings = (source: unknown, label: string): string[] => {
    if (!Array.isArray(source) || source.some(item => typeof item !== 'string')) {
      throw new Error(`${label} must be an array of strings`)
    }
    return source as string[]
  }
  const scopes = record.scopes
  if (scopes === null || typeof scopes !== 'object') throw new Error('gouziGrant.scopes must be an object')
  const scopeRecord = scopes as Record<string, unknown>
  return {
    runId: text('runId') as never,
    nodeId: text('nodeId'),
    attempt: integer('attempt'),
    executionId: text('executionId') as never,
    gouziId: text('gouziId') as never,
    generation: integer('generation'),
    authorityEpoch: text('authorityEpoch') as never,
    planHash: text('planHash'),
    scopes: {
      read: strings(scopeRecord.read, 'gouziGrant.scopes.read'),
      write: strings(scopeRecord.write, 'gouziGrant.scopes.write'),
      effects: strings(scopeRecord.effects, 'gouziGrant.scopes.effects'),
    },
    credentialRefs: strings(record.credentialRefs, 'gouziGrant.credentialRefs'),
    deadline: text('deadline'),
    offlineUntil: text('offlineUntil'),
    ...typeof record.resourceReservationId === 'string' ? { resourceReservationId: record.resourceReservationId } : {},
  }
}
