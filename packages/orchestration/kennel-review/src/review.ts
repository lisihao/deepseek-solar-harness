/** The review kind: offers finished kennel tasks to other members and starts a read-only review of one. */
import type { Context } from '@deepseek-ai/cordis'
import { PhysicalOperatorId } from '@deepseek-ai/dsh-physical-operator'
import {
  admissionGouziRecipients,
  GouziId,
  KENNEL_WORK_NODE_ID,
  OrchestrationRunId,
  kennelRoster,
  qualifiedKennelMembers,
  type KennelCollaborationCandidate,
  type KennelCollaborationFacts,
  type KennelCollaborationKind,
  type KennelCollaborationMember,
  type KennelCollaborationRequest,
  type KennelCollaborationStarted,
  type LogicalTaskGraphV1,
  type OrchestrationGouziRecipientV1,
  type OrchestrationNodeSpecV1,
  type OrchestrationRunSnapshot,
} from '@deepseek-ai/dsh-orchestration'
import type { Config } from './config.ts'
import { KENNEL_REREVIEW_KIND, KENNEL_REVIEW_KIND } from './kinds.ts'
import { APPROVE_LINE, CHANGES_LINE, previousOf, reviewNodeId, reviewOutcome, targetOf, type ReviewTarget } from './verdict.ts'

/** Assignment every reviewer reports. */
const REVIEWER_ROLE = 'reviewer'

/**
 * Whether a run is a finished kennel work task that members did, whose result a review can read.
 * @param run - a run of this Session.
 * @returns true when the run completed, is bound to members, and passed its `work` node.
 */
export function reviewable(run: OrchestrationRunSnapshot): boolean {
  return run.state === 'completed' && admissionGouziRecipients(run.admission).length > 0
    && run.nodes.some(node => node.id === KENNEL_WORK_NODE_ID && node.state === 'passed')
}

function offer(facts: KennelCollaborationFacts, config: Required<Config>): KennelCollaborationCandidate[] {
  return facts.runs.filter(reviewable).slice(0, config.maxTargets).flatMap((run) => {
    const authorIds = new Set(admissionGouziRecipients(run.admission).map(author => String(author.gouziId)))
    // Reviewers read the delivered files, so each needs file tools; the authors never review their own work.
    const qualified = qualifiedKennelMembers(facts, run.workspace, { workspacePolicy: true })
      .filter(member => !authorIds.has(member.gouziId))
    // The addressed member reviews alone; otherwise the members the message names, else the first members in registry order.
    const members = facts.recipient === undefined
      ? kennelRoster(qualified, facts.mentioned, { min: 1, max: config.maxReviewers }, authorIds)
      : qualified.filter(member => member.gouziId === facts.recipient?.gouziId && member.generation === facts.recipient.generation)
    if (members === undefined || members.length === 0) return []
    const names = facts.members.filter(member => authorIds.has(String(member.gouziId))).map(member => member.name)
    return [{
      kind: 'collaboration' as const,
      collaboration: KENNEL_REVIEW_KIND,
      id: JSON.stringify([KENNEL_REVIEW_KIND, String(run.runId), run.revision, run.workspace,
        ...members.map(member => [member.gouziId, member.generation, member.operatorId, member.model])]),
      workspace: run.workspace,
      members,
      details: { target: { runId: String(run.runId), title: run.title, authors: names } satisfies ReviewTarget },
    }]
  })
}

async function resultOf(ctx: Context, runId: string): Promise<string> {
  const id = OrchestrationRunId(runId)
  let afterSequence = 0
  let preview: string | undefined
  for (;;) {
    const page = await ctx.orchestrations.readEvents({ runId: id, afterSequence, limit: 500 })
    if (page.events.length === 0) break
    for (const event of page.events) {
      if (event.type === 'node.evidence.accepted' && event.nodeId === KENNEL_WORK_NODE_ID && typeof event.data.outputPreview === 'string') {
        preview = event.data.outputPreview
      }
    }
    afterSequence = page.nextSequence
  }
  if (preview === undefined) throw new Error(`task ${runId} has no accepted result to review`)
  return preview
}

function reviewNode(
  member: KennelCollaborationMember, index: number, target: ReviewTarget, result: string, request: KennelCollaborationRequest,
): OrchestrationNodeSpecV1 {
  const { limits } = request
  const again = request.candidate.collaboration === KENNEL_REREVIEW_KIND
  const previous = previousOf(request.candidate)
  const title = `${again ? '复审' : '评审'}：${target.title}`.slice(0, limits.titleMaxChars)
  return {
    id: reviewNodeId(index), dependsOn: [], requiredForCompletion: true, title,
    task: [
      `你是狗窝成员「${member.name}」，现在${again ? '复审' : '评审'}「${target.authors.join('、')}」已完成的任务。只读检查，不修改文件，不执行命令。`,
      `任务：${target.title}`,
      ...previous.length === 0 ? [] : [`上一轮评审要求修改的意见，作者已按它们返工：\n${previous.map(value => `- ${value.name}：\n${value.comment}`).join('\n')}`],
      `对方的结果（可能被截断）：\n${result}`,
      `用户的要求：${request.prompt}`,
      `${previous.length === 0 ? '' : '先逐条核对上一轮的意见是否已经解决，再检查有没有新的问题。'}对照任务目标检查这个结果，必要时读取工作区里相关文件核对。第一行只写「${APPROVE_LINE}」或「${CHANGES_LINE}」；之后逐条写意见，每条指出位置或依据。没有问题时说明你核对了什么。`,
    ].join('\n\n'),
    role: 'analysis', phase: 'execution', capabilityRequirements: [], capabilityBudget: [],
    contextPolicy: { maxTokens: limits.contextTokens, allowedSourceKinds: ['intent', 'artifact', 'capsule'], unavailableSource: 'block' },
    effectBudget: { read: ['**'], write: [], execute: [], network: [], cost: [], risk: [] },
    readScopes: ['**'], writeScopes: [], approvedSecretRefs: [],
    generationLimits: limits.generationLimits, workspaceToolLimits: limits.workspaceToolLimits,
    acceptance: [{ id: 'review', description: 'Return the review conclusion and comments.', kind: 'operator-completed' }],
    retryPolicy: { maxAttempts: 1, backoffMs: 0, retryableCodes: [] }, timeoutMs: limits.taskTimeoutMs,
    operator: { preferredIds: [member.operatorId], fallbackIds: [], profile: { model: member.model } },
  }
}

/**
 * Start a review of the task a candidate names, first or repeated.
 * @param ctx - context holding the orchestration service.
 * @param request - the chosen candidate and the user's message.
 * @returns the run and each reviewer's assignment.
 */
export async function startReview(ctx: Context, request: KennelCollaborationRequest): Promise<KennelCollaborationStarted> {
  const { candidate } = request
  const target = targetOf(candidate)
  const result = await resultOf(ctx, target.runId)
  const graph: LogicalTaskGraphV1 = {
    version: 1, title: `${candidate.collaboration === KENNEL_REREVIEW_KIND ? '复审' : '评审'}：${target.title}`.slice(0, request.limits.titleMaxChars),
    workspace: candidate.workspace,
    maxParallel: candidate.members.length, risk: 'low',
    nodes: candidate.members.map((member, index) => reviewNode(member, index, target, result, request)),
  }
  const recipients: OrchestrationGouziRecipientV1[] = candidate.members.map(member => ({
    gouziId: GouziId(member.gouziId), generation: member.generation, operatorIds: [PhysicalOperatorId(member.operatorId)],
  }))
  const [single] = recipients
  const compilation = await ctx.orchestrations.compile({
    intent: { request: request.prompt }, graph,
    admission: {
      policy: 'auto', route: 'taskgraph', sourceSessionId: request.sessionId, sourceMessageId: request.messageId,
      ...request.runtimeContext === undefined ? {} : { runtimeContext: request.runtimeContext },
      ...recipients.length === 1 && single !== undefined ? { gouziRecipient: single } : { gouziRecipients: recipients },
      rlm: 'disabled', autonomous: 'disabled',
    },
  })
  const run = await ctx.orchestrations.start({ commandId: request.commandId, compilationId: compilation.compilationId })
  return {
    runId: String(run.runId),
    assignments: candidate.members.map(member => ({ gouziId: member.gouziId, role: REVIEWER_ROLE })),
  }
}

/**
 * Describe the review kind for the kennel registry.
 * @param ctx - context holding the orchestration service.
 * @param config - review bounds.
 * @returns the kind to register.
 */
export function kennelReviewKind(ctx: Context, config: Required<Config>): KennelCollaborationKind {
  return {
    kind: KENNEL_REVIEW_KIND,
    label: '评审',
    roleLabels: { reviewer: '评审人' },
    guidance: '用户明确要求某只或几只狗子评审、检查、点评另一只狗子已完成的任务时选它；用户点了名的狗子就是评审人，候选里就是这些狗子；它只读不改文件，评审人不会是任务的做事人；用户没说评审哪个任务时选最近完成的那个',
    offer: facts => offer(facts, config),
    start: request => startReview(ctx, request),
    outcome: reviewOutcome,
  }
}
