/**
 * Wire vocabulary shared by the Gouzi Host routes and the browser panel. This file imports nothing from the
 * orchestration packages so the client bundle stays free of host code; a Host test pins the id lists to
 * `@deepseek-ai/dsh-orchestration`.
 * @module @deepseek-ai/dsh-ui-gouzi/contracts
 */

import z from '@deepseek-ai/schemastery'

/** Room read interval: integer milliseconds, including the schema's deployment default. */
export const GOUZI_ROOM_POLL_INTERVAL_SCHEMA = z.number().step(1).min(250).max(60_000).default(2_000)

/** Same-origin Host route of the Gouzi projection and controls. */
export const GOUZI_DASHBOARD_PATH = '/api/gouzi'

/** Header every state-changing request must carry, as a guard against cross-site form posts. */
export const GOUZI_CONTROL_HEADER = 'x-dsh-gouzi-control'

/** Avatars the panel can draw; order is the order shown in the adoption wizard. */
export const GOUZI_AVATARS = ['shiba', 'corgi', 'border-collie', 'poodle', 'bichon', 'mixed'] as const
/** One avatar id. */
export type GouziAvatar = (typeof GOUZI_AVATARS)[number]

/** Role templates; a role is a goal and delivery format, never a permission. */
export const GOUZI_ROLE_IDS = ['research', 'development', 'testing', 'curation', 'daily', 'custom'] as const
/** One role id. */
export type GouziRoleId = (typeof GOUZI_ROLE_IDS)[number]

/** Display name and one-line goal of every role template. */
export const GOUZI_ROLE_COPY: Readonly<Record<GouziRoleId, { readonly label: string; readonly goal: string }>> = {
  research: { label: '研究', goal: '查资料、读代码、写调研结论' },
  development: { label: '开发', goal: '在隔离的工作区里实现一个明确的改动' },
  testing: { label: '测试', goal: '补测试、复现问题、验证修复' },
  curation: { label: '整理', goal: '整理文档、清理目录、归档结论' },
  daily: { label: '日常', goal: '处理琐碎、重复的小任务' },
  custom: { label: '自定义', goal: '由你在任务里说明它要做什么' },
}

/** Display name of every avatar. */
export const GOUZI_AVATAR_NAMES: Readonly<Record<GouziAvatar, string>> = {
  shiba: '柴犬',
  corgi: '柯基',
  'border-collie': '边牧',
  poodle: '贵宾',
  bichon: '比熊',
  mixed: '串串',
}

/** Membership as stored on the main instance. */
export type GouziMembershipState = 'provisioning' | 'enabled' | 'retiring' | 'archived'
/** Whether the main instance can reach the member. */
export type GouziConnectionState = 'online' | 'unreachable'
/** What the member is doing. */
export type GouziActivityState = 'resting' | 'queued' | 'working' | 'awaiting-approval' | 'paused' | 'faulted'

/** The single state the panel shows; the detail keeps all three dimensions. */
export type GouziPrimaryState =
  | 'provisioning' | 'unreachable' | 'faulted' | 'awaiting-approval' | 'paused' | 'working' | 'queued'
  | 'resting' | 'retiring' | 'archived'

/** Panel copy of every primary state. */
export const GOUZI_STATE_COPY: Readonly<Record<GouziPrimaryState, string>> = {
  provisioning: '准备中',
  unreachable: '联系不上',
  faulted: '出错了',
  'awaiting-approval': '等你批准',
  paused: '已暂停',
  working: '工作中',
  queued: '排队中',
  resting: '休息中',
  retiring: '正在退役',
  archived: '已退役',
}

/**
 * Reduce the three independent dimensions to the one state the panel shows. Membership outside `enabled` decides
 * first; an unreachable member is reported as such before its last known activity, because that activity is stale.
 * @param member - membership, connection, and activity of one member.
 * @returns the primary state.
 */
export function gouziPrimaryState(member: {
  readonly membership: GouziMembershipState
  readonly connection: GouziConnectionState
  readonly activity: GouziActivityState
}): GouziPrimaryState {
  if (member.membership !== 'enabled') return member.membership
  if (member.connection === 'unreachable') return 'unreachable'
  return member.activity
}

/** One member as the panel receives it. */
export interface GouziMemberProjection {
  readonly gouziId: string
  readonly name: string
  readonly avatarId: GouziAvatar
  readonly role: GouziRoleId
  /** Native model the member is pinned to; absent means Smart Auto chooses. */
  readonly model?: string
  /** Machine the member lives on. */
  readonly hostId: string
  readonly hostLabel: string
  readonly membership: GouziMembershipState
  readonly connection: GouziConnectionState
  readonly activity: GouziActivityState
  readonly state: GouziPrimaryState
  readonly createdAt: string
}

/** Id of the host that is the machine running this Server. */
export const GOUZI_LOCAL_HOST_ID = 'local'

/** A machine members can live on. */
export interface GouziHostProjection {
  readonly hostId: string
  readonly label: string
  readonly kind: 'local' | 'ssh'
  /** `user@address:port` of an SSH host; absent for the local one. */
  readonly address?: string
  /** Version of DSH Desktop installed on an SSH host when it was last checked. */
  readonly appVersion?: string
}

/** The key a remote machine presented, for the user to compare before trusting it. */
export interface GouziHostInspection {
  readonly keyType: string
  /** `SHA256:` fingerprint in the form `ssh-keygen -lf` prints. */
  readonly fingerprint: string
}

/** One directory level on a host. */
export interface GouziFolderListing {
  readonly path: string
  /** Absent at the filesystem root. */
  readonly parent?: string
  readonly entries: readonly { readonly name: string; readonly path: string; readonly git: boolean }[]
}

/** Side-effect-free repository checks for the requested paths, in request order. */
export interface GouziProjectsCheck {
  readonly projects: readonly (
    | { readonly path: string; readonly usable: true }
    | { readonly path: string; readonly usable: false; readonly message: string }
  )[]
}

/** Everything the panel renders. */
export interface GouziDashboardV1 {
  readonly version: 1
  readonly generatedAt: string
  /** Most members one main instance may hold. */
  readonly limit: number
  /** Members that hold a slot; archived ones do not. */
  readonly used: number
  /** Whether this caller may adopt, edit, wake, rest, or retire. */
  readonly canManage: boolean
  /** Whether this Host can start member processes at all. */
  readonly hostAvailable: boolean
  /** The local machine first, then every SSH host the user added. */
  readonly hosts: readonly GouziHostProjection[]
  readonly members: readonly GouziMemberProjection[]
}

/** State-changing requests; every one targets this main instance's own members. */
export type GouziControlRequest =
  | {
    readonly action: 'adopt'
    readonly name: string
    readonly avatarId: GouziAvatar
    readonly role: GouziRoleId
    /** Machine the member lives on; absent means {@link GOUZI_LOCAL_HOST_ID}. */
    readonly hostId?: string
    /** Absolute paths, on that machine, of the Git workspaces the member may work on. */
    readonly projects: readonly string[]
  }
  | { readonly action: 'check-projects'; readonly hostId: string; readonly projects: readonly string[] }
  | { readonly action: 'host-inspect'; readonly address: string; readonly port: number; readonly user: string }
  | {
    readonly action: 'host-add'
    readonly address: string
    readonly port: number
    readonly user: string
    /** Login password; used once to install a dedicated key and never stored. */
    readonly password: string
    /** Fingerprint the user confirmed after `host-inspect`. */
    readonly fingerprint: string
    readonly label?: string
  }
  | { readonly action: 'host-remove'; readonly hostId: string }
  | { readonly action: 'browse'; readonly hostId: string; readonly path?: string }
  | {
    readonly action: 'edit'
    readonly gouziId: string
    readonly name?: string
    readonly avatarId?: GouziAvatar
    readonly role?: GouziRoleId
    /** A native model id to pin, or `null` to return to Smart Auto. */
    readonly model?: string | null
  }
  | { readonly action: 'models'; readonly gouziId: string }
  | { readonly action: 'wake'; readonly gouziId: string }
  | { readonly action: 'rest'; readonly gouziId: string }
  | { readonly action: 'retire'; readonly gouziId: string }

/** Reply to the `models` action: native models the member's registered runtimes offer now. */
export interface GouziModelOptions {
  /** Empty when the member is offline or its runtimes are unavailable. */
  readonly models: readonly string[]
}

/** Failure body of every non-2xx response. */
export interface GouziErrorV1 {
  readonly error: string
  readonly message: string
}

/** Current terminal task output attributed to the operator sealed for this attempt. */
export interface GouziRoomResultV1 {
  /** ISO timestamp of the authoritative result event, not the polling time. */
  readonly time: string
  readonly sequence: number
  readonly evidenceRef: string
  readonly outputPreview: string
  readonly accepted: boolean
  readonly operatorId: string
}

/** Current scheduler node; unknown lifecycle strings remain visible unchanged. */
export interface GouziRoomNodeV1 {
  readonly nodeId: string
  readonly title: string
  readonly state: string
  readonly attempt: number
  readonly capabilityGeneration: number
  readonly operatorId?: string
  readonly gouziId?: string
  readonly evidenceRefs: readonly string[]
  readonly executionPlanRef?: string
  readonly result?: GouziRoomResultV1
}

/** How a collaboration about a task ended up, as the kind that started it reports it. */
export interface GouziRoomOutcomeV1 {
  /** Registered kind, such as `review`. */
  readonly collaboration: string
  /** Run the collaboration started. */
  readonly runId: string
  readonly state: 'pending' | 'positive' | 'negative' | 'unclear'
  /** One short line for people. */
  readonly label: string
}

/** One member's part in a collaboration. */
export interface GouziRoomCollaborationMemberV1 {
  readonly gouziId: string
  /** The role the kind gave the member. */
  readonly role: string
  /** The role in words for people; the role itself when the kind has none. */
  readonly roleLabel: string
  /** The member's conclusion, when the kind reports one per member. */
  readonly conclusion?: string
  /** The member's own comments, Markdown. */
  readonly text?: string
}

/** A collaboration this session started, as the room shows it. */
export interface GouziRoomCollaborationV1 {
  /** Registered kind, such as `review`. */
  readonly collaboration: string
  /** The kind in words for people. */
  readonly label: string
  /** Run the collaboration started. */
  readonly runId: string
  /** State of that run. */
  readonly state: string
  /** The task the collaboration is about, when its kind says so. */
  readonly subject?: { readonly runId: string; readonly title: string }
  /** How it ended up, when its kind reports an outcome. */
  readonly outcome?: { readonly state: 'pending' | 'positive' | 'negative' | 'unclear'; readonly label: string }
  readonly members: readonly GouziRoomCollaborationMemberV1[]
}

/** Task admitted by this exact source session. */
export interface GouziRoomTaskV1 {
  readonly runId: string
  readonly title: string
  readonly state: string
  readonly revision: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly nodes: readonly GouziRoomNodeV1[]
  /** Collaborations about this task that report an outcome, oldest first; absent when there are none. */
  readonly outcomes?: readonly GouziRoomOutcomeV1[]
}

/** Read-only session room: roster, actual execution registrations, and admitted tasks. */
export interface GouziRoomSnapshotV1 {
  /** Validated Host read interval; the browser schedules only from this reply. */
  readonly roomPollIntervalMs: number
  readonly version: 1
  readonly sessionId: string
  readonly generatedAt: string
  readonly dashboard: GouziDashboardV1
  readonly execution: readonly {
    readonly gouziId: string
    readonly generation: number
    /** Project roots observed from the execution member; an empty list cannot authorize project selection. */
    readonly projectScopes: readonly string[]
    readonly operators: readonly {
      readonly operatorId: string
      readonly available: boolean
      readonly supportsGenerationLimits?: boolean
      readonly supportsGovernedWorkspacePolicy?: boolean
      readonly models: readonly string[]
      readonly unavailableReason?: string
    }[]
  }[]
  readonly tasks: readonly GouziRoomTaskV1[]
  /** Collaborations this session started, oldest first; absent when there are none. */
  readonly collaborations?: readonly GouziRoomCollaborationV1[]
}
