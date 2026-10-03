/** Durable registry of Gouzi execution hosts and members, written only by the main instance's store. */

import type { DatabaseSync } from 'node:sqlite'
import {
  countsTowardGouziLimit,
  GOUZI_AVATAR_IDS,
  GOUZI_MEMBER_LIMIT,
  GOUZI_ROLES,
  GouziAuthorityEpoch,
  GouziHostId,
  GouziId,
  GouziOwnerId,
  OrchestrationError,
  type GouziAvatarId,
  type GouziActivity,
  type GouziConnection,
  type GouziMembership,
  type GouziRecord,
  type GouziRole,
} from '@deepseek-ai/dsh-orchestration'

/** A paired execution host. The credential itself is never stored here, only its reference. */
export interface GouziHostRecord {
  readonly hostId: GouziHostId
  readonly label: string
  readonly endpoint: string
  /** The epoch this host accepts; minted when the host was paired. */
  readonly authorityEpoch: GouziAuthorityEpoch
  /** Name of the entry that holds the device credential. */
  readonly credentialRef: string
  readonly pairedAt: string
}

/** A member with the three independent state dimensions. */
export interface GouziMemberView extends GouziRecord {
  readonly connection: GouziConnection
  readonly activity: GouziActivity
}

/** Fields a user may change on a member. */
export interface GouziMemberEdit {
  readonly name?: string
  readonly avatarId?: GouziAvatarId
  readonly role?: GouziRole
}

/** Evidence required before a member leaves the member count. */
export interface GouziArchiveEvidence {
  readonly credentialsRevoked: boolean
  readonly workSettled: boolean
  readonly processTreeStopped: boolean
}

const MEMBERSHIP_FLOW: Readonly<Record<GouziMembership, readonly GouziMembership[]>> = {
  provisioning: ['enabled', 'retiring'],
  enabled: ['retiring'],
  retiring: ['enabled'],
  archived: [],
}

const NAME_LIMIT = 40

interface MemberRow {
  gouzi_id: string
  owner_id: string
  host_id: string
  generation: number
  name: string
  avatar_id: string
  role: string
  role_version: number
  policy_version: number
  membership: string
  connection: string
  activity: string
  created_at: string
  updated_at: string
}

interface HostRow {
  host_id: string
  label: string
  endpoint: string
  authority_epoch: string
  credential_ref: string
  paired_at: string
}

function checkName(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length === 0 || trimmed.length > NAME_LIMIT) {
    throw new OrchestrationError(`gouzi name must be 1 to ${String(NAME_LIMIT)} characters`, 'GOUZI_STATE_CONFLICT')
  }
  return trimmed
}

function checkAvatar(avatarId: string): GouziAvatarId {
  if (!(GOUZI_AVATAR_IDS as readonly string[]).includes(avatarId)) {
    throw new OrchestrationError(`unknown gouzi avatar ${avatarId}`, 'GOUZI_STATE_CONFLICT')
  }
  return avatarId as GouziAvatarId
}

function checkRole(role: string): GouziRole {
  if (!(GOUZI_ROLES as readonly string[]).includes(role)) {
    throw new OrchestrationError(`unknown gouzi role ${role}`, 'GOUZI_STATE_CONFLICT')
  }
  return role as GouziRole
}

function memberView(row: MemberRow): GouziMemberView {
  return {
    gouziId: GouziId(row.gouzi_id),
    ownerId: GouziOwnerId(row.owner_id),
    hostId: GouziHostId(row.host_id),
    generation: row.generation,
    name: row.name,
    avatarId: row.avatar_id as GouziAvatarId,
    role: row.role as GouziRole,
    roleVersion: row.role_version,
    policyVersion: row.policy_version,
    membership: row.membership as GouziMembership,
    connection: row.connection as GouziConnection,
    activity: row.activity as GouziActivity,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function hostView(row: HostRow): GouziHostRecord {
  return {
    hostId: GouziHostId(row.host_id),
    label: row.label,
    endpoint: row.endpoint,
    authorityEpoch: GouziAuthorityEpoch(row.authority_epoch),
    credentialRef: row.credential_ref,
    pairedAt: row.paired_at,
  }
}

/** Sole writer of `gouzi_hosts` and `gouzi_members`; every change is one immediate transaction. */
export class GouziRegistry {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Record a newly paired host.
   * @param host - host identity, endpoint, accepted epoch, and credential reference.
   * @returns the stored host.
   * @throws OrchestrationError - when the host id is already paired; re-pairing is an explicit later operation.
   */
  pairHost(host: Omit<GouziHostRecord, 'pairedAt'>): GouziHostRecord {
    return this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM gouzi_hosts WHERE host_id = ?').get(String(host.hostId)) !== undefined) {
        throw new OrchestrationError(`gouzi host ${String(host.hostId)} is already paired`, 'GOUZI_STATE_CONFLICT')
      }
      const pairedAt = new Date().toISOString()
      this.db.prepare(`
        INSERT INTO gouzi_hosts (host_id, label, endpoint, authority_epoch, credential_ref, paired_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(String(host.hostId), host.label, host.endpoint, String(host.authorityEpoch), host.credentialRef, pairedAt)
      return { ...host, pairedAt }
    })
  }

  /**
   * List paired hosts.
   * @returns hosts ordered by pairing time.
   */
  listHosts(): GouziHostRecord[] {
    return (this.db.prepare('SELECT * FROM gouzi_hosts ORDER BY paired_at, host_id').all() as unknown as HostRow[]).map(hostView)
  }

  /**
   * Read one paired host.
   * @param hostId - host identity.
   * @returns the host, or undefined when it is not paired.
   */
  getHost(hostId: GouziHostId): GouziHostRecord | undefined {
    const row = this.db.prepare('SELECT * FROM gouzi_hosts WHERE host_id = ?').get(String(hostId)) as unknown as HostRow | undefined
    return row === undefined ? undefined : hostView(row)
  }

  /**
   * Create a member in `provisioning` on a paired host.
   * @param input - identity and presentation of the new member.
   * @returns the stored member.
   * @throws OrchestrationError - `GOUZI_LIMIT_REACHED` when {@link GOUZI_MEMBER_LIMIT} non-archived members exist;
   *   `GOUZI_STATE_CONFLICT` for an unknown host, an id already in use, or an invalid name, avatar, or role.
   */
  create(input: {
    gouziId: GouziId
    ownerId: GouziOwnerId
    hostId: GouziHostId
    name: string
    avatarId: GouziAvatarId
    role: GouziRole
  }): GouziMemberView {
    const name = checkName(input.name)
    const avatarId = checkAvatar(input.avatarId)
    const role = checkRole(input.role)
    return this.transaction(() => {
      if (this.getHost(input.hostId) === undefined) {
        throw new OrchestrationError(`gouzi host ${String(input.hostId)} is not paired`, 'GOUZI_STATE_CONFLICT')
      }
      if (this.read(input.gouziId) !== undefined) {
        throw new OrchestrationError(`gouzi ${String(input.gouziId)} already exists`, 'GOUZI_STATE_CONFLICT')
      }
      const counted = this.list().filter(member => countsTowardGouziLimit(member.membership)).length
      if (counted >= GOUZI_MEMBER_LIMIT) {
        throw new OrchestrationError(
          `at most ${String(GOUZI_MEMBER_LIMIT)} gouzi members may exist; archive one first`,
          'GOUZI_LIMIT_REACHED',
        )
      }
      const now = new Date().toISOString()
      this.db.prepare(`
        INSERT INTO gouzi_members
          (gouzi_id, owner_id, host_id, generation, name, avatar_id, role, role_version, policy_version,
           membership, connection, activity, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?, ?, 1, 1, 'provisioning', 'unreachable', 'resting', ?, ?)
      `).run(String(input.gouziId), String(input.ownerId), String(input.hostId), name, avatarId, role, now, now)
      return this.require(input.gouziId)
    })
  }

  /**
   * List all members including archived ones.
   * @returns members ordered by creation time.
   */
  list(): GouziMemberView[] {
    return (this.db.prepare('SELECT * FROM gouzi_members ORDER BY created_at, gouzi_id').all() as unknown as MemberRow[]).map(memberView)
  }

  /**
   * Read one member.
   * @param gouziId - member identity.
   * @returns the member, or undefined when it does not exist.
   */
  read(gouziId: GouziId): GouziMemberView | undefined {
    const row = this.db.prepare('SELECT * FROM gouzi_members WHERE gouzi_id = ?').get(String(gouziId)) as unknown as MemberRow | undefined
    return row === undefined ? undefined : memberView(row)
  }

  /**
   * Change name, avatar, or role. The identity and generation never change; a role change bumps `roleVersion`.
   * @param gouziId - member identity.
   * @param edit - fields to change.
   * @returns the updated member.
   * @throws OrchestrationError - `GOUZI_STATE_CONFLICT` when the member is missing or archived, or a value is invalid.
   */
  edit(gouziId: GouziId, edit: GouziMemberEdit): GouziMemberView {
    return this.transaction(() => {
      const current = this.require(gouziId)
      if (current.membership === 'archived') {
        throw new OrchestrationError(`gouzi ${String(gouziId)} is archived`, 'GOUZI_STATE_CONFLICT')
      }
      const name = edit.name === undefined ? current.name : checkName(edit.name)
      const avatarId = edit.avatarId === undefined ? current.avatarId : checkAvatar(edit.avatarId)
      const role = edit.role === undefined ? current.role : checkRole(edit.role)
      this.db.prepare(`
        UPDATE gouzi_members SET name = ?, avatar_id = ?, role = ?, role_version = ?, updated_at = ? WHERE gouzi_id = ?
      `).run(name, avatarId, role, role === current.role ? current.roleVersion : current.roleVersion + 1, new Date().toISOString(), String(gouziId))
      return this.require(gouziId)
    })
  }

  /**
   * Move a member along `provisioning → enabled ⇄ retiring`. Archiving needs {@link GouziRegistry.archive}.
   * @param gouziId - member identity.
   * @param membership - the next membership.
   * @returns the updated member.
   * @throws OrchestrationError - `GOUZI_STATE_CONFLICT` for a missing member or a transition the flow does not allow.
   */
  setMembership(gouziId: GouziId, membership: Exclude<GouziMembership, 'archived'>): GouziMemberView {
    return this.transaction(() => {
      const current = this.require(gouziId)
      if (!MEMBERSHIP_FLOW[current.membership].includes(membership)) {
        throw new OrchestrationError(
          `gouzi ${String(gouziId)} cannot move from ${current.membership} to ${membership}`,
          'GOUZI_STATE_CONFLICT',
        )
      }
      this.db.prepare('UPDATE gouzi_members SET membership = ?, updated_at = ? WHERE gouzi_id = ?')
        .run(membership, new Date().toISOString(), String(gouziId))
      return this.require(gouziId)
    })
  }

  /**
   * Archive a retiring member, releasing its slot. An expired authorization is not evidence.
   * @param gouziId - member identity.
   * @param evidence - all three facts must be true.
   * @returns the archived member.
   * @throws OrchestrationError - `GOUZI_STATE_CONFLICT` when the member is not retiring or any evidence is missing.
   */
  archive(gouziId: GouziId, evidence: GouziArchiveEvidence): GouziMemberView {
    return this.transaction(() => {
      const current = this.require(gouziId)
      if (current.membership !== 'retiring') {
        throw new OrchestrationError(`gouzi ${String(gouziId)} must be retiring before it is archived`, 'GOUZI_STATE_CONFLICT')
      }
      if (!evidence.credentialsRevoked || !evidence.workSettled || !evidence.processTreeStopped) {
        throw new OrchestrationError(
          `gouzi ${String(gouziId)} needs revoked credentials, settled work, and a stopped process tree to be archived`,
          'GOUZI_STATE_CONFLICT',
        )
      }
      this.db.prepare("UPDATE gouzi_members SET membership = 'archived', updated_at = ? WHERE gouzi_id = ?")
        .run(new Date().toISOString(), String(gouziId))
      return this.require(gouziId)
    })
  }

  /**
   * Record what the main instance last observed. These two dimensions are independent of membership.
   * @param gouziId - member identity.
   * @param observed - the dimensions to replace.
   * @returns the updated member.
   */
  observe(gouziId: GouziId, observed: { connection?: GouziConnection; activity?: GouziActivity }): GouziMemberView {
    return this.transaction(() => {
      const current = this.require(gouziId)
      this.db.prepare('UPDATE gouzi_members SET connection = ?, activity = ?, updated_at = ? WHERE gouzi_id = ?').run(
        observed.connection ?? current.connection,
        observed.activity ?? current.activity,
        new Date().toISOString(),
        String(gouziId),
      )
      return this.require(gouziId)
    })
  }

  private require(gouziId: GouziId): GouziMemberView {
    const member = this.read(gouziId)
    if (member === undefined) {
      throw new OrchestrationError(`gouzi ${String(gouziId)} does not exist`, 'GOUZI_STATE_CONFLICT')
    }
    return member
  }

  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}
