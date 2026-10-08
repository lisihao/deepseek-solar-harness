/** Debate Provider side of the kennel seam: assigns roles to kennel members and starts the Debate. */

import { Service, type Context } from '@deepseek-ai/cordis'
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
import type {
  KennelDebateAssignment,
  KennelDebateMember,
  KennelDebateRequest,
  KennelDebateRun,
  KennelDebateStarter,
} from '@deepseek-ai/dsh-orchestration'

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

function slot(role: DebateRoleId, member: KennelDebateMember): DebateRoleSpecV1 {
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

function validate(members: readonly KennelDebateMember[]): void {
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

/** Starts Debates whose roster slots run on kennel members. */
export class KennelDebateProvider extends Service implements KennelDebateStarter {
  readonly minMembers = MIN_MEMBERS
  readonly maxMembers = MAX_MEMBERS

  constructor(ctx: Context) {
    super(ctx, 'kennelDebates')
  }

  async start(request: KennelDebateRequest): Promise<KennelDebateRun> {
    validate(request.members)
    const debates = this.ctx.get('debates')
    if (debates === undefined) throw new DebateError('the Debate service is unavailable', 'DEBATE_PROVIDER_UNAVAILABLE')
    const roles = rolesFor(request.members.length)
    const roster = request.members.map((member, index) => slot(roles[index] ?? JUDGE_ROLE, member))
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
      workspace: request.workspace,
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
        this.ctx.logger.warn(`kennel Debate ${started.runId} approval failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    return {
      runId: started.runId,
      assignments: request.members.map((member, index): KennelDebateAssignment => ({
        gouziId: member.gouziId,
        role: roles[index] ?? JUDGE_ROLE,
      })),
    }
  }
}
