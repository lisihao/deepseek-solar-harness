/** Extension point for work that kennel members do together: Debate, review, and later kinds. */
import type { GouziControl, GouziMemberView } from './gouzi.ts'
import type { OrchestrationNodeSpecV1, OrchestrationRunSnapshot, OrchestrationRuntimeContextV1 } from './index.ts'

/** Id of the node a kennel work task runs; a collaboration reviewing finished work looks for it. */
export const KENNEL_WORK_NODE_ID = 'work'

/** One registered execution entry of a member, as the registry reports it. */
export type KennelExecutionEntry = Awaited<ReturnType<GouziControl['executionOperators']>>[number]

/** One member a collaboration runs on, with the execution entry and model the Host confirmed for it. */
export interface KennelCollaborationMember {
  readonly gouziId: string
  readonly generation: number
  readonly name: string
  readonly role: string
  /** Full registered execution entry, `gouzi.<gouziId>.<operator>`. */
  readonly operatorId: string
  /** Native model the entry runs for this collaboration: the member's pinned model or the entry's default. */
  readonly model: string
}

/**
 * One Host-qualified collaboration the selection model may choose. The model returns `id` only, so an id must name
 * everything the offer depends on (members, generations, entries, models, targets, revisions): the Host re-offers
 * before it starts and refuses a choice whose id is no longer offered.
 */
export interface KennelCollaborationCandidate {
  readonly kind: 'collaboration'
  /** Registered kind that offered the candidate and will start it. */
  readonly collaboration: string
  readonly id: string
  readonly workspace: string
  /** Distinct members, in the order the kind assigns roles. */
  readonly members: readonly KennelCollaborationMember[]
  /** Kind-owned facts shown to the selection model and kept in the Session log; JSON values only. */
  readonly details: Readonly<Record<string, unknown>>
}

/** What the Host knows when it asks a kind for candidates. */
export interface KennelCollaborationFacts {
  readonly sessionId: string
  /** Every registered member. */
  readonly members: readonly GouziMemberView[]
  /** Current registered execution entries of all members. */
  readonly entries: readonly KennelExecutionEntry[]
  /** This Session's runs, newest first. */
  readonly runs: readonly OrchestrationRunSnapshot[]
  /** The member the user addressed directly, when the message was sent to one member. */
  readonly recipient?: { readonly gouziId: string; readonly generation: number }
}

/** Resource bounds the Host applies to every task a collaboration starts. */
export interface KennelCollaborationLimits {
  readonly contextTokens: number
  readonly taskTimeoutMs: number
  readonly titleMaxChars: number
  readonly generationLimits: NonNullable<OrchestrationNodeSpecV1['generationLimits']>
  readonly workspaceToolLimits: NonNullable<OrchestrationNodeSpecV1['workspaceToolLimits']>
}

/** A request to start the collaboration the user chose. */
export interface KennelCollaborationRequest {
  /** Idempotent command identity; repeating it returns the run it started. */
  readonly commandId: string
  readonly sessionId: string
  /** Identity of the user message that chose the collaboration. */
  readonly messageId: string
  /** The user's message, unmodified. */
  readonly prompt: string
  readonly candidate: KennelCollaborationCandidate
  readonly limits: KennelCollaborationLimits
  /** Request-time dynamic contexts captured from the Session. */
  readonly runtimeContext?: OrchestrationRuntimeContextV1
}

/** A started collaboration. */
export interface KennelCollaborationStarted {
  readonly runId: string
  /** What each member does in it, such as a Debate role or `reviewer`. */
  readonly assignments: readonly { readonly gouziId: string; readonly role: string }[]
}

/** One kind of collaboration. A Provider registers it; the Host dispatcher stays unaware of what it does. */
export interface KennelCollaborationKind {
  /** Stable name, such as `debate`. Names the kind in candidates and in the Session log; `work` and `control` are reserved. */
  readonly kind: string
  /** One model-facing sentence saying when the user's message asks for this kind. */
  readonly guidance: string
  /**
   * Offer the collaborations this kind can run now.
   * @param facts - members, entries, this Session's runs, and the addressed member.
   * @returns zero or more candidates; an empty list hides the kind from the selection model.
   */
  offer(facts: KennelCollaborationFacts): readonly KennelCollaborationCandidate[] | Promise<readonly KennelCollaborationCandidate[]>
  /**
   * Start the collaboration the user chose.
   * @param request - the unmodified message, the chosen candidate, and the Host's task limits.
   * @returns the durable run and each member's assignment.
   */
  start(request: KennelCollaborationRequest): Promise<KennelCollaborationStarted>
}

/** Registry of the collaboration kinds the kennel dispatcher can offer. */
export interface KennelCollaborations {
  /**
   * Register a kind.
   * @param kind - the kind to offer; a repeated or reserved name fails.
   * @returns the disposer that removes it.
   */
  register(kind: KennelCollaborationKind): () => void
  /**
   * List the registered kinds.
   * @returns the kinds in registration order.
   */
  kinds(): readonly KennelCollaborationKind[]
}

/** Kind names the dispatcher owns. */
export const RESERVED_COLLABORATION_KINDS: readonly string[] = ['work', 'control', 'clarify']

/** What a kind needs from an execution entry before it can run a member. */
export interface KennelBindingRequirements {
  /** The entry must support scoped file tools, for a member that reads the workspace. */
  readonly workspacePolicy?: boolean
}

/**
 * Pick the execution entry and model a member would run a collaboration on.
 * @param member - enabled member being considered.
 * @param entry - the member's current registered execution entries.
 * @param requirements - capabilities the kind needs.
 * @returns the first usable entry and its model, or undefined when no entry can run the member's pinned model.
 */
export function bindKennelMember(
  member: GouziMemberView,
  entry: KennelExecutionEntry,
  requirements: KennelBindingRequirements = {},
): { readonly operatorId: string; readonly model: string } | undefined {
  for (const operator of entry.operators) {
    if (!operator.available || operator.supportsGenerationLimits !== true) continue
    if (requirements.workspacePolicy === true && operator.supportsGovernedWorkspacePolicy !== true) continue
    if (member.model !== undefined && !operator.models.includes(member.model)) continue
    const model = member.model ?? operator.defaultModel ?? operator.models[0]
    if (model !== undefined) return { operatorId: operator.operatorId, model }
  }
  return undefined
}

/**
 * List the enabled members that can run a collaboration in a project, in registry order.
 * @param facts - members and entries.
 * @param workspace - project every member must hold.
 * @param requirements - capabilities the kind needs from each entry.
 * @returns one bound member per qualified member.
 */
export function qualifiedKennelMembers(
  facts: Pick<KennelCollaborationFacts, 'members' | 'entries'>,
  workspace: string,
  requirements: KennelBindingRequirements = {},
): KennelCollaborationMember[] {
  return facts.members.flatMap((member) => {
    if (member.membership !== 'enabled') return []
    const entry = facts.entries.find(value => value.gouziId === member.gouziId && value.generation === member.generation)
    const chosen = entry === undefined || !entry.projectScopes.includes(workspace)
      ? undefined
      : bindKennelMember(member, entry, requirements)
    return chosen === undefined ? [] : [{
      gouziId: String(member.gouziId), generation: member.generation, name: member.name, role: member.role, ...chosen,
    }]
  })
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    kennelCollaborations: KennelCollaborations
  }
}
