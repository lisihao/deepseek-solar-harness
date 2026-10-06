/**
 * Records that tie a long-lived execution member (a Gouzi) to the single TaskGraph authority. The main
 * instance is the only writer of these records; a Gouzi receives them as an immutable grant and answers with
 * a receipt. Nothing here starts a process or schedules work.
 * @module @deepseek-ai/dsh-orchestration/gouzi
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { PhysicalOperatorExecutionId } from '@deepseek-ai/dsh-physical-operator'
import type { OrchestrationArtifactRef, OrchestrationRunId } from './index.ts'

/** Most members one main-instance management domain may hold. Archived members do not count. */
export const GOUZI_MEMBER_LIMIT = 10

/** Permanent identity of one Gouzi; renaming never changes it. */
export type GouziId = Branded<'GouziId'>
/**
 * Brand one validated Gouzi identity.
 * @param value - validated durable identity.
 * @returns the opaque Gouzi identity.
 */
export const GouziId = (value: string): GouziId => value as GouziId

/** Identity of one execution host that runs Gouzi instances. */
export type GouziHostId = Branded<'GouziHostId'>
/**
 * Brand one validated host identity.
 * @param value - validated host identity.
 * @returns the opaque host identity.
 */
export const GouziHostId = (value: string): GouziHostId => value as GouziHostId

/** Identity of the main instance that owns a management domain. */
export type GouziOwnerId = Branded<'GouziOwnerId'>
/**
 * Brand one validated owner identity.
 * @param value - validated main-instance identity.
 * @returns the opaque owner identity.
 */
export const GouziOwnerId = (value: string): GouziOwnerId => value as GouziOwnerId

/**
 * Epoch minted when a host is first paired with a main instance and again at every explicit re-pairing. A host
 * accepts work only for the epoch it stored, so a main instance restored from an old snapshot cannot dispatch.
 */
export type GouziAuthorityEpoch = Branded<'GouziAuthorityEpoch'>
/**
 * Brand one validated authority epoch.
 * @param value - validated epoch minted at pairing.
 * @returns the opaque authority epoch.
 */
export const GouziAuthorityEpoch = (value: string): GouziAuthorityEpoch => value as GouziAuthorityEpoch

/** First avatar set; the avatar never decides capability or model. */
export const GOUZI_AVATAR_IDS = ['shiba', 'corgi', 'border-collie', 'poodle', 'bichon', 'mixed'] as const
/** One avatar of the first set. */
export type GouziAvatarId = (typeof GOUZI_AVATAR_IDS)[number]

/** First role templates; a role is a goal and a delivery format, not a permission. */
export const GOUZI_ROLES = ['research', 'development', 'testing', 'curation', 'daily', 'custom'] as const
/** One role template. */
export type GouziRole = (typeof GOUZI_ROLES)[number]

/**
 * Membership of one Gouzi. Every value except `archived` holds one of the {@link GOUZI_MEMBER_LIMIT} slots,
 * including a member whose process is stopped or whose host is unreachable.
 */
export type GouziMembership = 'provisioning' | 'enabled' | 'retiring' | 'archived'
/** Whether the main instance can reach the member's host; independent of membership and activity. */
export type GouziConnection = 'online' | 'unreachable'
/** What the member is doing; independent of membership and connection. */
export type GouziActivity = 'resting' | 'queued' | 'working' | 'awaiting-approval' | 'paused' | 'faulted'

/**
 * Whether a member holds one of the limited slots. A member leaves the count only when its credentials are
 * revoked, its in-flight work is settled, and its process tree is stopped or its execution environment is
 * reliably isolated, which is what `archived` records. An expired authorization is not proof of that.
 * @param membership - the member's membership state.
 * @returns true when the member counts toward {@link GOUZI_MEMBER_LIMIT}.
 */
export function countsTowardGouziLimit(membership: GouziMembership): boolean {
  return membership !== 'archived'
}

/** The main instance's durable record of one Gouzi. */
export interface GouziRecord {
  readonly gouziId: GouziId
  readonly ownerId: GouziOwnerId
  readonly hostId: GouziHostId
  /** Increases whenever the instance is re-created or re-paired, so credentials and grants of an older generation are rejected. */
  readonly generation: number
  readonly name: string
  readonly avatarId: GouziAvatarId
  readonly role: GouziRole
  readonly roleVersion: number
  readonly policyVersion: number
  readonly membership: GouziMembership
  readonly createdAt: string
  readonly updatedAt: string
}

/** One operator a Gouzi can use, as the host last observed it. */
export interface GouziOperatorCapability {
  /** Full registered execution identity, including the native provider suffix for a remote Gouzi. */
  readonly operatorId: string
  readonly available: boolean
  /** Why the operator cannot run, such as a missing login. */
  readonly unavailableReason?: string
  readonly models: readonly string[]
}

/** What a Gouzi can do now. A new task re-checks it; an expired snapshot is not evidence. */
export interface GouziCapabilitySnapshot {
  readonly gouziId: GouziId
  readonly generation: number
  /** Increases at every observation. */
  readonly revision: number
  readonly observedAt: string
  readonly expiresAt: string
  readonly operators: readonly GouziOperatorCapability[]
  /** Project roots the member may use. */
  readonly projectScopes: readonly string[]
  /** Active tasks the member runs at once; the first version allows one. */
  readonly maxActiveTasks: number
}

/** File and effect scopes a grant allows; anything outside is refused before any side effect. */
export interface GouziGrantScopes {
  readonly read: readonly string[]
  readonly write: readonly string[]
  readonly effects: readonly string[]
}

/**
 * Authorization to run exactly one sealed task attempt. The main instance signs it from the user's policy; the
 * member checks the identity, generation, epoch, plan digest, scopes, and deadline before it starts.
 */
export interface GouziExecutionGrant {
  readonly runId: OrchestrationRunId
  readonly nodeId: string
  readonly attempt: number
  readonly executionId: PhysicalOperatorExecutionId
  readonly gouziId: GouziId
  readonly generation: number
  readonly authorityEpoch: GouziAuthorityEpoch
  /**
   * SHA-256, as lowercase hexadecimal, of the exact execution request derived from the sealed node plan. The member
   * recomputes it from the request it received and refuses the execution when the two differ.
   */
  readonly planHash: string
  readonly scopes: GouziGrantScopes
  /** References to credentials the host keeps; the grant never carries a secret. */
  readonly credentialRefs: readonly string[]
  /** Latest time the attempt may run while the main instance is reachable. */
  readonly deadline: string
  /** Latest time the member may keep running without the main instance. */
  readonly offlineUntil: string
  readonly resourceReservationId?: string
}

/** Stage of one execution on the member. */
export type GouziExecutionStatus = 'accepted' | 'running' | 'settled' | 'failed' | 'indeterminate'

/** Why the member says an execution ended. */
export interface GouziExitEvidence {
  readonly stopReason: string
  readonly exitCode?: number
  readonly summary?: string
}

/**
 * The member's durable answer for one execution. A receipt with the same `executionId` and `requestHash` is
 * returned unchanged on a repeated request; the same `executionId` with another hash is a conflict.
 */
export interface GouziExecutionReceipt {
  readonly executionId: PhysicalOperatorExecutionId
  readonly gouziId: GouziId
  readonly generation: number
  /** SHA-256 of the request that created the execution. */
  readonly requestHash: string
  /** Starts at zero and increases by one for every state change of this execution. */
  readonly sequence: number
  readonly status: GouziExecutionStatus
  readonly artifactRefs: readonly OrchestrationArtifactRef[]
  readonly exitEvidence?: GouziExitEvidence
  readonly startedAt?: string
  readonly settledAt?: string
}

/** A bounded handoff between two members of one run, delivered through the main instance. */
export interface GouziHandoff {
  readonly messageId: string
  readonly runId: OrchestrationRunId
  readonly nodeId: string
  readonly senderId: GouziId
  readonly recipientId: GouziId
  readonly purpose: string
  readonly inputRefs: readonly OrchestrationArtifactRef[]
  /** The scope the recipient may treat the material as covered by; a handoff cannot widen it. */
  readonly scopeRef: OrchestrationArtifactRef
}

/** Review state of one experience proposal. */
export type GouziProposalStatus = 'submitted' | 'reviewing' | 'adopted' | 'rejected' | 'rolled-back'

/** A reusable lesson from accepted work; it cannot add permissions, budget, ownership, or code. */
export interface GouziExperienceProposal {
  readonly proposalId: string
  readonly sourceExecutionIds: readonly PhysicalOperatorExecutionId[]
  readonly evidenceRefs: readonly OrchestrationArtifactRef[]
  /** SHA-256 of the proposed content. */
  readonly contentHash: string
  readonly targetRole: GouziRole
  readonly parentVersion: number
  readonly status: GouziProposalStatus
}

/** Orchestration event names written for Gouzi members; every one is ignorable by an older reader. */
export const GOUZI_EVENT_TYPES = [
  'gouzi.member.created',
  'gouzi.member.updated',
  'gouzi.member.retiring',
  'gouzi.member.archived',
  'gouzi.host.paired',
  'gouzi.grant.issued',
  'gouzi.execution.received',
  'gouzi.execution.settled',
] as const
/** One Gouzi orchestration event name. */
export type GouziEventType = (typeof GOUZI_EVENT_TYPES)[number]

/** A paired execution host. The credential itself is never stored, only its reference. */
export interface GouziHostRecord {
  readonly hostId: GouziHostId
  readonly label: string
  /** The authority epoch this host accepts; minted when the host was paired. */
  readonly authorityEpoch: GouziAuthorityEpoch
  /** Name of the credential entry that holds the device credential. */
  readonly credentialRef: string
  readonly pairedAt: string
}

/** A member with its three independent state dimensions and process facts. */
export interface GouziMemberView extends GouziRecord {
  readonly connection: GouziConnection
  readonly activity: GouziActivity
  /** How long after issue an execution grant may start work. */
  readonly grantDeadlineMs: number
  /** Where the member's process listens now; absent until it has been started. */
  readonly endpoint?: string
}

/** Fields a user may change on a member; identity and generation never change. */
export interface GouziMemberEdit {
  readonly name?: string
  readonly avatarId?: GouziAvatarId
  readonly role?: GouziRole
}

/** Facts required before a retiring member leaves the member count. */
export interface GouziArchiveEvidence {
  readonly credentialsRevoked: boolean
  readonly workSettled: boolean
  readonly processTreeStopped: boolean
}

/** Input for creating a member in `provisioning`. */
export interface GouziCreateInput {
  readonly gouziId: GouziId
  readonly ownerId: GouziOwnerId
  readonly hostId: GouziHostId
  readonly name: string
  readonly avatarId: GouziAvatarId
  readonly role: GouziRole
  readonly grantDeadlineMs: number
}

/**
 * Registry operations the main instance offers for hosts and members. Every mutation is a single transaction of
 * the sole TaskGraph authority; a refused eleventh member fails with `GOUZI_LIMIT_REACHED`.
 */
export interface GouziControl {
  /** @returns every paired host and every member, archived ones included. */
  list(): Promise<{ readonly hosts: readonly GouziHostRecord[]; readonly members: readonly GouziMemberView[] }>
  /**
   * Read enabled members' registered execution entries with fresh provider availability and model checks. Connection
   * status alone does not qualify an entry; absent or stale-generation registrations produce an empty operator list.
   * This query neither starts members nor changes membership, grants, or task scheduling.
   * @returns current member generations and full registered operator IDs, availability reasons, and native models.
   */
  executionOperators(): Promise<readonly {
    readonly gouziId: GouziId
    readonly generation: number
    readonly operators: readonly GouziOperatorCapability[]
  }[]>
  /**
   * Record a newly paired host.
   * @param host - identity, accepted authority epoch, and credential reference.
   * @returns the stored host.
   */
  pairHost(host: Omit<GouziHostRecord, 'pairedAt'>): Promise<GouziHostRecord>
  /**
   * Create a member in `provisioning`.
   * @param input - identity, presentation, role, and grant lifetime.
   * @returns the stored member.
   */
  create(input: GouziCreateInput): Promise<GouziMemberView>
  /**
   * Change a member's name, avatar, or role.
   * @param gouziId - member identity.
   * @param edit - fields to change.
   * @returns the updated member.
   */
  edit(gouziId: GouziId, edit: GouziMemberEdit): Promise<GouziMemberView>
  /**
   * Move a member along `provisioning → enabled ⇄ retiring`.
   * @param gouziId - member identity.
   * @param membership - the next membership.
   * @returns the updated member.
   */
  setMembership(gouziId: GouziId, membership: Exclude<GouziMembership, 'archived'>): Promise<GouziMemberView>
  /**
   * Record where a member's process listens.
   * @param gouziId - member identity.
   * @param endpoint - absolute http or https URL.
   * @returns the updated member.
   */
  setEndpoint(gouziId: GouziId, endpoint: string): Promise<GouziMemberView>
  /**
   * Archive a retiring member, which releases its slot.
   * @param gouziId - member identity.
   * @param evidence - revoked credentials, settled work, and a stopped process tree.
   * @returns the archived member.
   */
  archive(gouziId: GouziId, evidence: GouziArchiveEvidence): Promise<GouziMemberView>
}
