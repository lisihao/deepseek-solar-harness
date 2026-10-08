/** Debate as a kennel collaboration kind: offers Debates over kennel members, assigns roles, and starts them. */

import type { Context } from '@deepseek-ai/cordis'
import {
  DEFAULT_DEBATE_CONVERGENCE,
  DEFAULT_DEBATE_PERSONAS,
  DEFAULT_DEBATE_ROUNDS,
  DebateError,
  defaultDebateBudget,
  type DebatePolicyV1,
  type DebateRoleId,
  type DebateRoleSpecV1,
} from '@deepseek-ai/dsh-debate'
import {
  qualifiedKennelMembers,
  type KennelCollaborationCandidate,
  type KennelCollaborationFacts,
  type KennelCollaborationKind,
  type KennelCollaborationMember,
  type KennelCollaborationRequest,
  type KennelCollaborationStarted,
} from '@deepseek-ai/dsh-orchestration'

/** Name this kind registers under. */
export const KENNEL_DEBATE_KIND = 'debate'

/** Roles in the order members are given; the judge is always the last member. */
const PARTICIPANT_ROLES: readonly DebateRoleId[] = ['constructive-proposer', 'skeptical-falsifier', 'evidence-auditor']
const JUDGE_ROLE: DebateRoleId = 'decision-judge'
const MIN_MEMBERS = 3
const MAX_MEMBERS = PARTICIPANT_ROLES.length + 1
/** A kennel Debate uses the ordinary depth: three numbered rounds. */
const PLANNED_ROUNDS = 3
const APPROVAL_REASON = 'The user asked for this Debate in the kennel.'

/**
 * Assign each member a role: the leading members argue, the last member judges, so the judge never argues.
 * @param count - number of members, between the minimum and maximum.
 * @returns one role per member, in member order.
 */
function rolesFor(count: number): readonly DebateRoleId[] {
  return [...PARTICIPANT_ROLES.slice(0, count - 1), JUDGE_ROLE]
}

function slot(role: DebateRoleId, member: KennelCollaborationMember): DebateRoleSpecV1 {
  return {
    version: 1,
    role,
    kind: role === JUDGE_ROLE ? 'judge' : 'participant',
    operatorId: member.operatorId,
    model: member.model,
    tier: 'medium',
    source: 'native-subscription',
    persona: DEFAULT_DEBATE_PERSONAS[role],
    required: true,
  }
}

function validate(members: readonly KennelCollaborationMember[]): void {
  if (members.length < MIN_MEMBERS || members.length > MAX_MEMBERS) {
    throw new DebateError(`a kennel Debate needs ${String(MIN_MEMBERS)} to ${String(MAX_MEMBERS)} members`, 'DEBATE_ROSTER_INVALID')
  }
  if (new Set(members.map(member => member.gouziId)).size !== members.length) {
    throw new DebateError('a kennel Debate needs distinct members', 'DEBATE_ROSTER_INVALID')
  }
  const foreign = members.find(member => !member.operatorId.startsWith(`gouzi.${member.gouziId}.`))
  if (foreign !== undefined) {
    throw new DebateError(`execution entry ${foreign.operatorId} does not belong to member ${foreign.gouziId}`, 'DEBATE_ROSTER_INVALID')
  }
}

/**
 * Offer one Debate per project that enough members can argue.
 * Members are taken in registry order and the first `MAX_MEMBERS` of them argue; roles follow that order, so the
 * judge is never a member who also argued. A message addressed to one member is not a Debate.
 * @param facts - members and execution entries.
 * @returns one candidate per project with at least `MIN_MEMBERS` qualified members.
 */
function offer(facts: KennelCollaborationFacts): KennelCollaborationCandidate[] {
  if (facts.recipient !== undefined) return []
  const workspaces = new Set(facts.entries.flatMap(entry => entry.projectScopes))
  return [...workspaces].flatMap((workspace) => {
    const qualified = qualifiedKennelMembers(facts, workspace)
    if (qualified.length < MIN_MEMBERS) return []
    const members = qualified.slice(0, MAX_MEMBERS)
    return [{
      kind: 'collaboration' as const,
      collaboration: KENNEL_DEBATE_KIND,
      id: JSON.stringify([
        KENNEL_DEBATE_KIND, workspace, ...members.map(value => [value.gouziId, value.generation, value.operatorId, value.model]),
      ]),
      workspace,
      members,
      details: {},
    }]
  })
}

/**
 * Start a Debate whose roster slots run on the candidate's members, and approve it.
 * @param ctx - context holding the Debate service.
 * @param request - chosen candidate and the user's message.
 * @returns the Debate run and each member's role.
 */
async function start(ctx: Context, request: KennelCollaborationRequest): Promise<KennelCollaborationStarted> {
  const { members } = request.candidate
  validate(members)
  const debates = ctx.get('debates')
  if (debates === undefined) throw new DebateError('the Debate service is unavailable', 'DEBATE_PROVIDER_UNAVAILABLE')
  const roles = rolesFor(members.length)
  const roster = members.map((member, index) => slot(roles[index] ?? JUDGE_ROLE, member))
  const policy: DebatePolicyV1 = {
    version: 1,
    mode: 'enabled',
    roster,
    budget: defaultDebateBudget(PLANNED_ROUNDS, roster.length),
    rounds: DEFAULT_DEBATE_ROUNDS,
    convergence: DEFAULT_DEBATE_CONVERGENCE,
    preserveDissent: true,
  }
  const started = await debates.start({
    version: 1,
    commandId: request.commandId,
    workspace: request.candidate.workspace,
    prompt: request.prompt,
    objective: request.prompt,
    policy,
    execution: { version: 1, kind: 'standalone' },
    sourceSessionId: request.sessionId,
    ...request.runtimeContext === undefined ? {} : { runtimeContext: request.runtimeContext },
  })
  if (started.state === 'awaiting_approval') {
    // Approval returns when the rounds settle, so it runs in the background; the run keeps its own state.
    void debates.control({
      version: 1,
      commandId: `${request.commandId}:approve`,
      runId: started.runId,
      expectedRevision: started.revision,
      action: 'approve',
      reason: APPROVAL_REASON,
    }).catch((error: unknown) => {
      ctx.logger.warn(`kennel Debate ${started.runId} approval failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  return {
    runId: started.runId,
    assignments: members.map((member, index) => ({ gouziId: member.gouziId, role: roles[index] ?? JUDGE_ROLE })),
  }
}

/**
 * Describe the Debate kind for the kennel registry.
 * @param ctx - context holding the Debate service.
 * @returns the kind to register.
 */
export function kennelDebateKind(ctx: Context): KennelCollaborationKind {
  return {
    kind: KENNEL_DEBATE_KIND,
    guidance: '用户明确要求多只狗子一起辩论、讨论同一个问题时选它；它不修改文件，也不评审已完成的任务',
    offer,
    start: request => start(ctx, request),
  }
}

/** Plugin that registers the Debate kind while a kennel registry is present. */
export const kennelDebatePlugin = {
  name: 'debate-orchestration-kennel',
  inject: ['kennelCollaborations'],
  apply(ctx: Context): void {
    ctx.effect(() => ctx.kennelCollaborations.register(kennelDebateKind(ctx)), 'debate-orchestration: kennel Debate kind')
  },
}
