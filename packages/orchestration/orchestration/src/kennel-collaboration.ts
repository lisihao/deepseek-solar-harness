/** Extension point for work that kennel members do together: Debate, review, and later kinds. */
import type { GouziControl, GouziMemberView } from './gouzi.ts'
import type {
  LogicalTaskGraphV1, OrchestrationNodeSpecV1, OrchestrationRunSnapshot, OrchestrationRuntimeContextV1,
} from './index.ts'

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

/** One Host-qualified way for a single member to take a task: a member, a project, a mode, and the entries that can run it. */
export interface KennelWorkOffer {
  readonly id: string
  readonly gouziId: string
  readonly generation: number
  readonly name: string
  readonly role: string
  readonly activity: string
  readonly workspace: string
  readonly mode: 'chat' | 'read' | 'write'
  readonly operatorIds: readonly string[]
  /** Native model the member is pinned to; every listed operator offers it. Absent when Smart Auto chooses. */
  readonly model?: string
}

/** A work task this Session's dispatcher admitted, with the member offer that took it. */
export interface KennelWorkRecord {
  readonly runId: string
  readonly offer: KennelWorkOffer
}

/** The final text of one node of a collaboration's run. */
export interface KennelCollaborationResult {
  readonly nodeId: string
  /** Whether the Scheduler accepted the node's result. */
  readonly accepted: boolean
  readonly text: string
}

/** What one member contributed to a collaboration's outcome, for the room to show beside the member. */
export interface KennelCollaborationPart {
  readonly gouziId: string
  /** One short word or phrase, such as the member's conclusion. */
  readonly label: string
  /** The member's own words, such as review comments; Markdown. */
  readonly text?: string
}

/**
 * How a collaboration ended up for the task it is about. The room shows `label` on that task, and a later kind reads
 * `state` and `details` to decide what to offer.
 */
export interface KennelCollaborationOutcome {
  /** Run of the task the collaboration is about. */
  readonly subjectRunId: string
  /** `pending` while it runs, `positive` or `negative` when it reached a verdict, `unclear` when it did not. */
  readonly state: 'pending' | 'positive' | 'negative' | 'unclear'
  /** One short line for people. */
  readonly label: string
  /** What each member contributed, when the kind has something to say per member. */
  readonly parts?: readonly KennelCollaborationPart[]
  /** Kind-owned facts, JSON values only. */
  readonly details: Readonly<Record<string, unknown>>
}

/** A collaboration this Session already started. */
export interface KennelCollaborationRecord {
  readonly collaboration: string
  /** Run the collaboration started. */
  readonly runId: string
  /** The user message that chose it. */
  readonly messageId: string
  readonly candidate: KennelCollaborationCandidate
  /** What each member does in it, as the kind reported when it started. */
  readonly assignments: KennelCollaborationStarted['assignments']
  /** The outcome its kind reported from the run's current results, when the kind reports outcomes. */
  readonly outcome?: KennelCollaborationOutcome
}

/** A member the user's message names. */
export interface KennelMentionedMember {
  readonly gouziId: string
  readonly generation: number
  readonly name: string
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
  /** The ways a single member could take a task now, as the dispatcher offers them. */
  readonly workOffers: readonly KennelWorkOffer[]
  /** Work tasks this Session admitted, oldest first. */
  readonly work: readonly KennelWorkRecord[]
  /** Collaborations this Session started, oldest first. */
  readonly earlier: readonly KennelCollaborationRecord[]
  /** The member the user addressed directly, when the message was sent to one member. */
  readonly recipient?: { readonly gouziId: string; readonly generation: number }
  /**
   * Enabled members whose name the message contains, in order of first mention. A name that more than one member
   * has is ambiguous and is left out. Empty when the message names none.
   */
  readonly mentioned: readonly KennelMentionedMember[]
}

/** Resource bounds the Host applies to every task a collaboration starts. */
export interface KennelCollaborationLimits {
  readonly contextTokens: number
  readonly taskTimeoutMs: number
  readonly titleMaxChars: number
  readonly generationLimits: NonNullable<OrchestrationNodeSpecV1['generationLimits']>
  readonly workspaceToolLimits: NonNullable<OrchestrationNodeSpecV1['workspaceToolLimits']>
}

/** A task for one member that the Host will bound and certify exactly as it does for a user's own message. */
export interface KennelWorkGraphInput {
  readonly offer: KennelWorkOffer
  /** The task text the member receives. */
  readonly text: string
  /** Title of the task in the room, bounded by the Host; the task text when absent. */
  readonly title?: string
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
  /**
   * Build the certified graph for one member's task, with the Host's file scopes, isolation, and verification rules.
   * A kind that gives a member work calls this instead of composing permissions itself.
   * @param input - the member offer and the task text.
   * @returns the graph to compile for that member.
   */
  workGraph(input: KennelWorkGraphInput): LogicalTaskGraphV1
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
  /** Short name for people, such as `辩论`, shown in the room. */
  readonly label: string
  /** Names for people of the assignment roles this kind reports; a role without one is shown as it is. */
  readonly roleLabels?: Readonly<Record<string, string>>
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
  /**
   * Read the state of a run this kind started that the orchestration service does not list, such as a Debate kept by
   * another service. Optional: a kind whose runs are orchestration runs omits it.
   * @param record - the collaboration, with the candidate that started it.
   * @returns an orchestration run state word, or undefined when it cannot be read.
   */
  runState?(record: Omit<KennelCollaborationRecord, 'outcome'>): Promise<string | undefined>
  /**
   * Read what a collaboration it started has concluded. Optional: a kind that reaches no verdict omits it.
   * @param record - the collaboration, with the candidate that started it.
   * @param run - the collaboration's current run.
   * @param results - final text of each node of the run that has one.
   * @returns the outcome for the task the collaboration is about, or undefined when it is about none.
   */
  outcome?(
    record: Omit<KennelCollaborationRecord, 'outcome'>,
    run: OrchestrationRunSnapshot,
    results: readonly KennelCollaborationResult[],
  ): KennelCollaborationOutcome | undefined
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

/** How many members a collaboration takes. */
export interface KennelRosterBounds {
  readonly min: number
  readonly max: number
}

/**
 * Choose the members a collaboration runs on when the user's message may name some.
 * The members the message names are used, in the order it names them, and none is replaced by another: a named member
 * that cannot take part, or more named members than the collaboration takes, leaves nothing to offer, so the user
 * is asked instead of getting someone else. Members the collaboration excludes are dropped from the names, and a
 * message that then names nobody gets the default roster. Fewer named members than the minimum are completed from
 * the other qualified members in registry order.
 * @param qualified - members that can take part, in registry order.
 * @param mentioned - members the message names.
 * @param bounds - fewest and most members.
 * @param excluded - ids of members that never take part, such as the authors of a task under review.
 * @returns the members, or undefined when nothing can be offered.
 */
export function kennelRoster(
  qualified: readonly KennelCollaborationMember[],
  mentioned: readonly KennelMentionedMember[],
  bounds: KennelRosterBounds,
  excluded: ReadonlySet<string> = new Set(),
): readonly KennelCollaborationMember[] | undefined {
  const named = mentioned.filter(value => !excluded.has(value.gouziId))
  if (named.length === 0) return qualified.length < bounds.min ? undefined : qualified.slice(0, bounds.max)
  if (named.length > bounds.max) return undefined
  const chosen: KennelCollaborationMember[] = []
  for (const value of named) {
    const member = qualified.find(candidate => candidate.gouziId === value.gouziId && candidate.generation === value.generation)
    if (member === undefined) return undefined
    chosen.push(member)
  }
  const fillers = qualified.filter(candidate => !chosen.some(member => member.gouziId === candidate.gouziId))
  const members = [...chosen, ...fillers.slice(0, Math.max(0, bounds.min - chosen.length))]
  return members.length < bounds.min ? undefined : members
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    kennelCollaborations: KennelCollaborations
  }
}
