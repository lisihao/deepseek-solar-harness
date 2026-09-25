/**
 * Trajectory list fold: expand assistant blocks, attach usage to Message,
 * own-duration times, in-flight partial/runningCalls, and group descriptions.
 */
import type {
  AssistantBlock,
  AssistantMessageNode,
  ConversationLocation,
  ConversationSnapshot,
  RequestInspectionSnapshot,
  RequestPromptChange,
  RequestView,
  ToolCallBlock,
  ToolResultNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  TrajectoryCellProps,
  TrajectorySourceBlock,
} from './trajectory-record.ts'
import type {
  TrajectoryDebateExecution, TrajectoryDebateProgress, TrajectoryDebateTraceEntry,
  TrajectoryPhysicalOperatorExecution,
} from './trajectory-contract.ts'
import { formatElapsedSeconds } from './trajectory-record.ts'

/** One Message or Step group inside a turn. */
export interface TrajectoryGroupModel {
  title: string
  description?: string
  cells: readonly TrajectoryCellProps[]
}

/** One sticky turn, or a standalone compaction section between turns. */
export interface TrajectoryTurnModel {
  turn: number | null
  groups: readonly TrajectoryGroupModel[]
}

/** Snapshot slice the trajectory view folds. */
export interface TrajectoryLayoutInput {
  nodes: ConversationSnapshot['nodes']
  eventLocations?: ReadonlyMap<number, ConversationLocation>
  partial: ConversationSnapshot['partial']
  runningCalls: ConversationSnapshot['runningCalls']
  requests?: readonly RequestView[]
  callSchemas?: RequestInspectionSnapshot['callSchemas']
  physicalOperatorExecutions?: readonly TrajectoryPhysicalOperatorExecution[]
  debateExecutions?: readonly TrajectoryDebateExecution[]
}

interface UsageLike {
  inputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  outputTokens?: number
  reasoningTokens?: number
}

interface DetailedUsageLike {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadInputTokens?: number
  readonly cacheWriteInputTokens?: number
  readonly costUsd?: number
}

function detailedUsageProps(usage: DetailedUsageLike | undefined): Pick<
  TrajectoryCellProps,
  'input' | 'output' | 'cacheRead' | 'cacheWrite'
> {
  return {
    ...(usage?.inputTokens === undefined ? {} : { input: usage.inputTokens }),
    ...(usage?.outputTokens === undefined ? {} : { output: usage.outputTokens }),
    ...(usage?.cacheReadInputTokens === undefined ? {} : { cacheRead: usage.cacheReadInputTokens }),
    ...(usage?.cacheWriteInputTokens === undefined ? {} : { cacheWrite: usage.cacheWriteInputTokens }),
  }
}

/** Cell plus absolute ms for group wall-span descriptions. */
interface LaidCell {
  cell: TrajectoryCellProps
  absTime: number | null
  toolName?: string
  callId?: string
  subCalls?: readonly ToolCallBlock[]
}

interface LaidGroup {
  title: string
  laid: LaidCell[]
}

interface TurnBucket {
  groups: LaidGroup[]
}

type AssistantRequestView = Extract<RequestView, { purpose: 'assistant' }>
type CompactionRequestView = Extract<RequestView, { purpose: 'compaction' }>

type InputNode = Extract<
  ConversationSnapshot['nodes'][number],
  { kind: 'user' | 'steering' | 'context' }
>

type OrderedLayoutEntry =
  | {
    kind: 'node'
    seq: number
    node: ConversationSnapshot['nodes'][number]
    nodeIndex: number
  }
  | {
    kind: 'compaction'
    seq: number
    request: CompactionRequestView
  }
  | {
    kind: 'system'
    seq: number
    request: AssistantRequestView
    change: RequestPromptChange
  }
  | {
    kind: 'request'
    seq: number
    request: AssistantRequestView
  }

function layoutEntryOrder(entry: OrderedLayoutEntry): number {
  return entry.kind === 'system' && entry.change.kind === 'initial'
    ? Number.NEGATIVE_INFINITY
    : entry.seq
}

function inputCellDetail(node: InputNode): Pick<
  TrajectoryCellProps,
  | 'text'
  | 'previewMarkdown'
  | 'sourceSeq'
  | 'messageSource'
  | 'inputDetail'
  | 'sourceBlocks'
  | 'timeSeconds'
  | 'startedAt'
> {
  const previewMarkdown = previewContent(node.content)
  return {
    text: '',
    ...(previewMarkdown === undefined ? {} : { previewMarkdown }),
    sourceSeq: node.seq,
    messageSource: node.source,
    inputDetail: detailContent(node.content),
    sourceBlocks: node.content.map(block => sourceBlock(block)),
    timeSeconds: 0,
    startedAt: finiteTime(node.time),
  }
}

/**
 * Fold a snapshot into turn → Message/Step groups with expanded cells.
 * @param input - nodes plus in-flight partial/runningCalls.
 * @returns turns ordered by first appearance.
 */
export function deriveTrajectoryLayout(input: TrajectoryLayoutInput): readonly TrajectoryTurnModel[] {
  const {
    nodes, eventLocations, partial, runningCalls, requests = [], callSchemas,
    physicalOperatorExecutions = [], debateExecutions = [],
  } = input
  const resultByCall = indexResults(nodes)
  const callById = new Map<string, ToolCallBlock>(resultByCall)
  for (const call of runningCalls) callById.set(call.callId, call)
  const emittedCallIds = indexAssistantCallIds(nodes)
  const followingAssistants = indexFollowingAssistants(nodes)
  const callStartById = new Map<string, number>()
  for (const result of resultByCall.values()) {
    const startedAt = finiteTime(result.callTime)
    if (startedAt !== null) callStartById.set(result.callId, startedAt)
  }
  for (const call of runningCalls) {
    const startedAt = finiteTime(call.time)
    if (startedAt !== null) callStartById.set(call.callId, startedAt)
  }

  const turns = new Map<number, TurnBucket>()
  const standaloneCompactions: TurnBucket[] = []
  let index = 0
  let prevAbsTime: number | null = null
  let lastAssistantTurn: number | null = null

  const bucket = (turn: number) => {
    let entry = turns.get(turn)
    if (entry === undefined) {
      entry = { groups: [] }
      turns.set(turn, entry)
    }
    return entry
  }

  const pushMessage = (turn: number, laid: LaidCell) => {
    const groups = bucket(turn).groups
    const last = groups.at(-1)
    if (last?.title === 'Message') {
      last.laid.push(laid)
      return
    }
    groups.push({ title: 'Message', laid: [laid] })
  }
  const pushStep = (turn: number, step: number, laid: readonly LaidCell[]) => {
    if (laid.length === 0) return
    const groups = bucket(turn).groups
    const title = `Step ${step}`
    const existing = groups.find(group => group.title === title)
    if (existing !== undefined) {
      existing.laid.push(...laid)
      return
    }
    groups.push({ title, laid: [...laid] })
  }
  const pushStepInput = (turn: number, step: number, laid: readonly LaidCell[]) => {
    if (laid.length === 0) return
    const groups = bucket(turn).groups
    const title = `Step ${step}`
    const existing = groups.find(group => group.title === title)
    if (existing === undefined) {
      groups.push({ title, laid: [...laid] })
      return
    }
    const request = existing.laid.findIndex(entry => entry.cell.requestOnly === true)
    if (request === -1) existing.laid.push(...laid)
    else existing.laid.splice(request, 0, ...laid)
  }

  const representedRequests = new Set<string>()
  for (const node of nodes) {
    if (node.kind === 'assistant' && node.step > 0) {
      representedRequests.add(`${node.turn}\u0000${node.step}`)
    }
  }
  if (partial !== null && partial.step > 0) {
    representedRequests.add(`${partial.turn}\u0000${partial.step}`)
  }
  for (const call of runningCalls) {
    if (call.step > 0) representedRequests.add(`${call.turn}\u0000${call.step}`)
  }

  const entries: OrderedLayoutEntry[] = [
    ...nodes.map((node, nodeIndex) => ({
      kind: 'node' as const,
      seq: node.seq,
      node,
      nodeIndex,
    })),
    ...requests
      .filter((request): request is CompactionRequestView =>
        request.purpose === 'compaction')
      .map(request => ({
        kind: 'compaction' as const,
        seq: request.startSeq,
        request,
      })),
    ...requests.flatMap(request => request.purpose !== 'assistant'
      || request.promptChange === undefined
      || request.prompt === undefined
      ? []
      : [{
        kind: 'system' as const,
        seq: request.promptChange.seq,
        request,
        change: request.promptChange,
      }]),
    ...requests
      .filter((request): request is AssistantRequestView =>
        request.purpose === 'assistant')
      .filter(request =>
        !representedRequests.has(`${request.turn}\u0000${request.step}`),
      )
      .map(request => ({
        kind: 'request' as const,
        seq: request.startSeq,
        request,
      })),
  ].sort((left, right) => layoutEntryOrder(left) - layoutEntryOrder(right))

  for (const entry of entries) {
    if (entry.kind === 'request') {
      const { request } = entry
      pushStep(request.turn, request.step, [{
        absTime: finiteTime(request.startedAt),
        cell: {
          index: ++index,
          kind: 'message',
          text: '',
          sourceSeq: request.startSeq,
          requestOnly: true,
          timeSeconds: request.completedAt === null
            ? null
            : durationSeconds(request.completedAt, request.startedAt),
          startedAt: finiteTime(request.startedAt),
          ...(request.status === 'error' ? { isError: true } : {}),
        },
      }])
      prevAbsTime = finiteTime(request.completedAt)
        ?? finiteTime(request.startedAt)
        ?? prevAbsTime
      continue
    }
    if (entry.kind === 'system') {
      const { change, request } = entry
      const turn = change.kind === 'initial'
        ? firstVisibleTurn(nodes, partial)
        : enclosingPromptTurn(nodes, change.seq, partial)
      pushMessage(turn, {
        absTime: finiteTime(change.time),
        cell: {
          index: ++index,
          kind: 'system',
          text: promptChangeLabel(change),
          sourceSeq: change.seq,
          ...(request.prompt === undefined ? {} : { promptDetail: request.prompt }),
          ...(change.previous === undefined
            ? {}
            : { previousPromptDetail: change.previous }),
          timeSeconds: 0,
          startedAt: finiteTime(change.time),
        },
      })
      prevAbsTime = finiteTime(change.time) ?? prevAbsTime
      continue
    }
    if (entry.kind === 'compaction') {
      const request = entry.request
      const rawOutput = request.rawOutput ?? request.summary
      const thinkingDetail = rawOutput === undefined
        ? ''
        : detailReasoning(rawOutput)
      const cell: TrajectoryCellProps = {
        index: ++index,
        kind: 'compacted',
        text: request.status === 'running'
          ? 'Compacting context…'
          : request.status === 'error'
            ? request.error ?? 'Compaction failed'
            : request.summary === undefined
              ? 'Context compacted'
              : '',
        ...(request.status === 'complete' && request.summary !== undefined
          ? previewContentProperty(request.summary)
          : {}),
        sourceSeq: request.startSeq,
        ...(request.summary === undefined
          ? {}
          : {
            outputDetail: detailContent(request.summary),
            outputBlocks: request.summary.map(block => sourceBlock(block)),
          }),
        ...(thinkingDetail === '' ? {} : { thinkingDetail }),
        ...(rawOutput === undefined
          ? {}
          : { sourceBlocks: rawOutput.map(block => sourceBlock(block)) }),
        ...(request.status === 'error' ? { isError: true } : {}),
        timeSeconds: request.completedAt === null
          ? null
          : durationSeconds(request.completedAt, request.startedAt),
        startedAt: finiteTime(request.startedAt),
      }
      attachUsage(cell, request.usage as UsageLike | undefined)
      const compaction: TurnBucket = {
        groups: [{
          title: `Compaction ${request.startSeq}`,
          laid: [{
            absTime: finiteTime(request.startedAt),
            cell,
          }],
        }],
      }
      if (request.turn === null) standaloneCompactions.push(compaction)
      else bucket(request.turn).groups.push(...compaction.groups)
      prevAbsTime = finiteTime(request.completedAt) ?? finiteTime(request.startedAt) ?? prevAbsTime
      continue
    }
    const { node, nodeIndex: i } = entry
    if (node.kind === 'user') {
      // user/message has no turn on the wire; enclose it in the next assistant
      // (or partial) turn, else open the turn after the last assistant.
      const turn = enclosingUserTurn(followingAssistants[i], partial, lastAssistantTurn)
      pushMessage(turn, {
        absTime: finiteTime(node.time),
        cell: {
          index: ++index,
          kind: 'user',
          ...inputCellDetail(node),
          opensTurn: true,
        },
      })
      prevAbsTime = finiteTime(node.time) ?? prevAbsTime
      continue
    }
    if (node.kind === 'steering') {
      const placement = steeringPlacement(
        followingAssistants[i],
        partial,
        lastAssistantTurn,
        eventLocations?.get(node.seq),
      )
      const laid = {
        absTime: finiteTime(node.time),
        cell: {
          index: ++index,
          kind: 'user' as const,
          ...inputCellDetail(node),
        },
      }
      if (placement.step === undefined) pushMessage(placement.turn, laid)
      else pushStepInput(placement.turn, placement.step, [laid])
      prevAbsTime = finiteTime(node.time) ?? prevAbsTime
      continue
    }
    if (node.kind === 'assistant') {
      const laidList = withSubCalls(
        expandAssistant(node, index + 1, prevAbsTime, resultByCall, callStartById, callById),
      )
      if (node.step > 0) pushStep(node.turn, node.step, laidList)
      else for (const laid of laidList) pushMessage(node.turn, laid)
      const last = laidList[laidList.length - 1]
      if (last !== undefined) index = last.cell.index
      prevAbsTime = finiteTime(node.time) ?? prevAbsTime
      lastAssistantTurn = node.turn
      continue
    }
    if (node.kind === 'context') {
      const turn = enclosingUserTurn(followingAssistants[i], partial, lastAssistantTurn)
      pushMessage(turn, {
        absTime: finiteTime(node.time),
        cell: {
          index: ++index,
          kind: 'context',
          ...inputCellDetail(node),
        },
      })
      prevAbsTime = finiteTime(node.time) ?? prevAbsTime
      continue
    }
    if (node.kind === 'compaction') {
      // Chat owns the human-facing compaction marker. It contributes no
      // duplicate trajectory cell, but still advances the duration cursor.
      prevAbsTime = finiteTime(node.time) ?? prevAbsTime
      continue
    }
    if (node.kind === 'tool-result') {
      if (!emittedCallIds.has(node.callId)) {
        const toolName = node.call?.name
        const resultPreview = summarizeResult(node)
        const laidList: LaidCell[] = [{
          absTime: finiteTime(node.callTime ?? node.time),
          ...(toolName !== undefined ? { toolName } : {}),
          callId: node.callId,
          subCalls: node.subCalls,
          cell: {
            index: ++index,
            kind: 'tool',
            sourceSeq: node.seq,
            ...(node.call !== null
              ? summarizeCall(node.call.name, node.call.argsRaw)
              : resultAsText(resultPreview)),
            ...(node.call !== null ? { inputDetail: node.call.argsRaw } : {}),
            outputDetail: detailResult(node),
            outputBlocks: node.content.map(block => sourceBlock(block)),
            ...resultPreview,
            callId: node.callId,
            isError: node.isError,
            timeSeconds: durationSeconds(node.time, node.callTime),
            startedAt: finiteTime(node.callTime),
          },
        }]
        for (const laid of expandSubCalls(node.subCalls, index)) {
          laidList.push(laid)
          index = laid.cell.index
        }
        pushStep(0, 1, laidList)
      }
      prevAbsTime = finiteTime(node.time) ?? prevAbsTime
    }
  }

  if (partial !== null) {
    const fake: AssistantMessageNode = {
      kind: 'assistant', seq: Number.MAX_SAFE_INTEGER, time: 0,
      turn: partial.turn, step: partial.step, blocks: partial.blocks,
    }
    const laidList = withSubCalls(expandAssistant(
      fake,
      index + 1,
      prevAbsTime,
      resultByCall,
      callStartById,
      callById,
      { streaming: true },
    ))
    if (partial.step > 0) pushStep(partial.turn, partial.step, laidList)
    else for (const laid of laidList) pushMessage(partial.turn, laid)
    const last = laidList[laidList.length - 1]
    if (last !== undefined) index = last.cell.index
  }

  const seenCalls = collectCallIds(turns)
  for (const call of runningCalls) {
    if (seenCalls.has(call.callId)) continue
    const laidList: LaidCell[] = [{
      absTime: null,
      toolName: call.name,
      callId: call.callId,
      subCalls: call.subCalls,
      cell: {
        index: ++index,
        kind: 'tool',
        ...summarizeCall(call.name, call.argsRaw),
        inputDetail: call.argsRaw,
        callId: call.callId,
        timeSeconds: null,
        startedAt: finiteTime(call.time),
      },
    }]
    for (const laid of expandSubCalls(call.subCalls, index)) {
      laidList.push(laid)
      index = laid.cell.index
    }
    if (call.step > 0) pushStep(call.turn, call.step, laidList)
    else for (const laid of laidList) pushMessage(call.turn, laid)
  }

  for (const current of [...physicalOperatorExecutions]
    .sort((left, right) => left.dispatchSeq - right.dispatchSeq)) {
    const operatorGroup: LaidGroup = {
      title: `Operator · ${physicalOperatorLabel(current.operatorId)} · ${shortCommandId(current.commandId)}`,
      laid: current.entries.map(entry => ({
        absTime: finiteTime(entry.time),
        cell: physicalOperatorCell(current, entry, ++index),
      })),
    }
    if (operatorGroup.laid.length === 0) continue
    bucket(current.turn).groups.push(operatorGroup)
  }

  for (const current of [...debateExecutions]
    .sort((left, right) => left.dispatchSeq - right.dispatchSeq || left.runId.localeCompare(right.runId))) {
    const laid: LaidCell[] = []
    for (const entry of current.entries) {
      if (entry.progress === undefined) {
        laid.push({
          absTime: finiteTime(entry.time),
          cell: debateCell(current, entry, ++index),
        })
      } else {
        laid.push({
          absTime: debateProgressTime(entry.progress, entry.time),
          cell: debateProgressCell(current, entry, entry.progress, ++index),
        })
      }
    }
    const debateGroup: LaidGroup = {
      title: `Debate · ${current.topic ?? '未记录议题'}`,
      laid,
    }
    if (debateGroup.laid.length === 0) continue
    bucket(current.turn).groups.push(debateGroup)
  }

  // Orphan turn-0 cells (orphaned tools) fold into Turn 1.
  const prologue = turns.get(0)
  if (prologue !== undefined) {
    turns.delete(0)
    const emptyTurn = (): TurnBucket => ({ groups: [] })
    const first = turns.get(1) ?? emptyTurn()
    first.groups = [...prologue.groups, ...first.groups]
    turns.set(1, first)
  }

  // Physical commands are session events, not a trailing appendix. Sort all
  // groups by their first source sequence (then wall time) so a command that
  // started between a user message and its assistant/tool records stays in
  // that position. Cell indexes are reassigned after this ordering step.
  for (const turn of turns.values()) {
    turn.groups.sort(compareLaidGroups)
  }

  for (const entry of [...turns.values(), ...standaloneCompactions]) {
    for (const group of entry.groups) {
      for (const laid of group.laid) attachToolSchema(laid, callSchemas)
    }
  }

  const ordered = [
    ...[...turns.entries()].map(([turn, entry]) => toTurnModel(turn, entry)),
    ...standaloneCompactions.map(entry => toTurnModel(null, entry)),
  ].sort(compareTurnModels)
  let nextIndex = 0
  return ordered.map(turn => ({
    ...turn,
    groups: turn.groups.map(group => ({
      ...group,
      cells: group.cells.map(cell => ({ ...cell, index: ++nextIndex })),
    })),
  }))
}

function compareLaidGroups(left: LaidGroup, right: LaidGroup): number {
  const leftKey = laidGroupOrder(left)
  const rightKey = laidGroupOrder(right)
  return compareOrderPair(leftKey, rightKey)
}

function laidGroupOrder(group: LaidGroup): { sequence: number; time: number } {
  const sequence = Math.min(
    ...group.laid.flatMap(value => typeof value.cell.sourceSeq === 'number' && Number.isFinite(value.cell.sourceSeq)
      ? [value.cell.sourceSeq]
      : []),
    Number.POSITIVE_INFINITY,
  )
  const time = Math.min(
    ...group.laid.flatMap(value => value.absTime !== null && Number.isFinite(value.absTime)
      ? [value.absTime]
      : []),
    Number.POSITIVE_INFINITY,
  )
  return { sequence, time }
}

function compareTurnModels(left: TrajectoryTurnModel, right: TrajectoryTurnModel): number {
  const leftKey = turnModelOrder(left)
  const rightKey = turnModelOrder(right)
  const order = compareOrderPair(leftKey, rightKey)
  return order !== 0 ? order : firstCellIndex(left) - firstCellIndex(right)
}

function compareOrderPair(
  left: { sequence: number; time: number },
  right: { sequence: number; time: number },
): number {
  if (left.sequence !== right.sequence) return left.sequence < right.sequence ? -1 : 1
  if (left.time !== right.time) return left.time < right.time ? -1 : 1
  // Modern JS sorting is stable; returning zero preserves the source order
  // when both source coordinates are identical or unavailable.
  return 0
}

function turnModelOrder(turn: TrajectoryTurnModel): { sequence: number; time: number } {
  const cells = turn.groups.flatMap(group => group.cells)
  return {
    sequence: Math.min(
      ...cells.flatMap(cell => typeof cell.sourceSeq === 'number' && Number.isFinite(cell.sourceSeq)
        ? [cell.sourceSeq]
        : []),
      Number.POSITIVE_INFINITY,
    ),
    time: Math.min(
      ...cells.flatMap(cell => cell.startedAt !== null && cell.startedAt !== undefined && Number.isFinite(cell.startedAt)
        ? [cell.startedAt]
        : []),
      Number.POSITIVE_INFINITY,
    ),
  }
}

function physicalOperatorLabel(operatorId: string): string {
  return operatorId === 'claude-code' ? 'Claude Code' : operatorId === 'codex' ? 'Codex' : operatorId
}

function shortCommandId(commandId: string): string {
  return commandId.length <= 12 ? commandId : `${commandId.slice(0, 11)}…`
}

function physicalOperatorCell(
  execution: TrajectoryPhysicalOperatorExecution,
  entry: TrajectoryPhysicalOperatorExecution['entries'][number],
  index: number,
): TrajectoryCellProps {
  const base = {
    index,
    recordId: entry.type === 'tool' && entry.tool !== undefined
      ? `physical-operator\u0000${execution.commandId}\u0000tool\u0000${entry.tool.toolCallId}`
      : `physical-operator\u0000${execution.commandId}\u0000${entry.seq}`,
    kind: 'operator' as const,
    sourceSeq: entry.seq,
    timeSeconds: 0,
    startedAt: finiteTime(entry.time),
  }
  if (entry.type === 'dispatch') return { ...base, text: `${physicalOperatorLabel(execution.operatorId)} 已派发` }
  if (entry.type === 'progress') return {
    ...base,
    text: `阶段 · ${physicalOperatorPhaseLabel(entry.phase)}`,
  }
  if (entry.type === 'terminal') return {
    ...base,
    text: entry.outcome === 'success' || entry.code === 'completed'
      ? `执行完成 · ${entry.code ?? 'completed'}`
      : `执行终止 · ${entry.code ?? '未知原因'}`,
    ...(entry.outcome === 'success' || entry.code === 'completed' ? {} : { isError: true }),
  }
  if (entry.type === 'degraded') return {
    ...base,
    text: `轨迹降级 · ${entry.code ?? 'PROGRESS_UNAVAILABLE'}`,
    isError: true,
  }
  if (entry.type === 'tool') {
    const tool = entry.tool
    if (tool === undefined) return { ...base, text: '工具状态已更新' }
    const status = tool.status === 'running'
      ? '运行中'
      : tool.status === 'indeterminate'
        ? '状态不确定'
        : tool.status === 'error' ? '失败' : '完成'
    const inputDetail = physicalOperatorShapeLabel(tool.argumentsShape)
    const resultDetail = physicalOperatorShapeLabel(tool.resultShape)
    const preview = tool.status === 'error' ? tool.errorPreview : tool.resultPreview
    const previewLabel = tool.status === 'error' ? '错误预览' : '公开结果预览'
    const resultPreview = preview ?? resultDetail
    const outputDetail = [
      resultDetail === undefined ? undefined : `结果结构\n${resultDetail}`,
      preview === undefined ? undefined : `${previewLabel}\n\n${preview}`,
      tool.status === 'error' ? '工具报告失败' : undefined,
      tool.status === 'indeterminate' ? '工具结果尚无法证明' : undefined,
    ].filter((value): value is string => value !== undefined).join('\n\n')
    return {
      ...base,
      text: `DSH 工具${status}${tool.toolName === undefined ? '' : ` · ${tool.toolName}`}`,
      callId: tool.toolCallId,
      ...(tool.toolName === undefined ? {} : { toolName: tool.toolName }),
      ...(inputDetail === undefined ? {} : {
        inputDetail,
        previewMarkdown: inputDetail,
      }),
      ...(resultPreview === undefined ? {} : { resultPreviewMarkdown: resultPreview }),
      ...(outputDetail === '' ? {} : { outputDetail }),
      ...(tool.status === 'error' || tool.status === 'indeterminate' ? { isError: true } : {}),
    }
  }
  const observation = entry.observation
  if (observation === undefined) return { ...base, text: '已收到原生状态更新' }
  if (observation.kind === 'public-output') {
    const preview = observation.publicOutputPreview
    return {
      ...base,
      text: preview === undefined ? '公开输出已更新' : '公开输出',
      ...(preview === undefined ? {} : {
        previewMarkdown: preview,
        outputDetail: `公开输出\n\n${preview}`,
      }),
    }
  }
  if (observation.kind === 'tool-started' || observation.kind === 'tool-completed') {
    const toolName = observation.toolName
    const phase = observation.kind === 'tool-started' ? '开始' : '完成'
    return {
      ...base,
      text: `原生工具${phase}${toolName === undefined ? '' : ` · ${toolName}`}`,
      ...(toolName === undefined ? {} : { toolName, outputDetail: `原生工具\n\n${toolName}` }),
    }
  }
  if (observation.kind === 'approval-required') {
    const approvalDetail = [
      observation.approvalKind === undefined ? undefined : `权限：${observation.approvalKind}`,
      observation.approvalPreview,
    ].filter((value): value is string => value !== undefined && value.length > 0).join('\n\n')
    return {
      ...base,
      text: `需要批准 · ${observation.approvalKind ?? '原生权限'}`,
      ...(approvalDetail === '' ? {} : { outputDetail: approvalDetail }),
      isError: true,
    }
  }
  const usage = observation.usage
  const fragments = [
    usage?.inputTokens === undefined ? undefined : `输入 ${String(usage.inputTokens)}`,
    usage?.outputTokens === undefined ? undefined : `输出 ${String(usage.outputTokens)}`,
    usage?.costUsd === undefined ? undefined : `费用 $${usage.costUsd.toFixed(6)}`,
  ].filter((value): value is string => value !== undefined)
  const usageLines = [
    usage?.inputTokens === undefined ? undefined : `- 输入：${String(usage.inputTokens)}`,
    usage?.outputTokens === undefined ? undefined : `- 输出：${String(usage.outputTokens)}`,
    usage?.cacheReadInputTokens === undefined ? undefined : `- 缓存命中：${String(usage.cacheReadInputTokens)}`,
    usage?.cacheWriteInputTokens === undefined ? undefined : `- 缓存写入：${String(usage.cacheWriteInputTokens)}`,
    usage?.costUsd === undefined ? undefined : `- 费用：$${usage.costUsd.toFixed(6)}`,
  ].filter((value): value is string => value !== undefined)
  return {
    ...base,
    text: fragments.length === 0 ? '用量已更新' : `用量更新 · ${fragments.join(' · ')}`,
    ...(usageLines.length === 0 ? {} : { outputDetail: `用量\n\n${usageLines.join('\n')}` }),
    ...detailedUsageProps(usage),
  }
}

function debateCell(
  execution: TrajectoryDebateExecution,
  entry: TrajectoryDebateTraceEntry,
  index: number,
): TrajectoryCellProps {
  const role = entry.role
  const roleTitle = role?.title
  const round = entry.round === undefined ? undefined : `第 ${String(entry.round)} 轮`
  const route = role === undefined
    ? undefined
    : debateRouteLabel(role)
  const status = debateStateLabel(entry.state)
  const heading = [round, roleTitle, status].filter((value): value is string => value !== undefined).join(' · ')
  const base: TrajectoryCellProps = {
    index,
    recordId: `debate\u0000${execution.runId}\u0000${String(entry.sourceSequence)}`,
    kind: 'debate',
    sourceSeq: entry.seq,
    text: heading === '' ? `Debate · ${status}` : heading,
    timeSeconds: 0,
    startedAt: finiteTime(entry.time),
    ...(entry.state === 'failed' || entry.state === 'blocked' || entry.state === 'indeterminate'
      ? { isError: true }
      : {}),
  }
  const output = entry.synthesis?.outputPreview ?? entry.publicOutputPreview
  const details = debateDetails(entry, route)
  const usage = entry.usage
  return {
    ...base,
    ...(output === undefined ? {} : { previewMarkdown: output }),
    ...(details === undefined ? {} : { outputDetail: details }),
    ...detailedUsageProps(usage),
  }
}

function debateProgressTime(progress: TrajectoryDebateProgress, fallback: number): number | null {
  const timestamp = Date.parse(progress.sourceTime)
  return Number.isFinite(timestamp) ? timestamp : finiteTime(fallback)
}

function debateProgressCell(
  execution: TrajectoryDebateExecution,
  entry: TrajectoryDebateTraceEntry,
  progress: TrajectoryDebateProgress,
  index: number,
): TrajectoryCellProps {
  const role = entry.role
  const roleTitle = role?.title
  const round = entry.round === undefined ? undefined : `第 ${String(entry.round)} 轮`
  const prefix = [round, roleTitle].filter((value): value is string => value !== undefined)
  const label = debateProgressLabel(progress)
  const output = progress.publicOutputPreview ?? progress.approvalPreview
  const details = debateProgressDetails(progress, role === undefined ? undefined : debateRouteLabel(role))
  return {
    index,
    recordId: `debate\u0000${execution.runId}\u0000${String(entry.sourceSequence)}\u0000progress`,
    kind: 'debate',
    sourceSeq: entry.seq,
    text: [...prefix, label].join(' · '),
    ...(output === undefined ? {} : { previewMarkdown: output }),
    ...(details === undefined ? {} : { outputDetail: details }),
    ...(progress.kind === 'approval-required' ? { isError: true } : {}),
    timeSeconds: 0,
    startedAt: debateProgressTime(progress, entry.time),
    ...detailedUsageProps(progress.usage),
  }
}

function debateProgressLabel(progress: TrajectoryDebateProgress): string {
  if (progress.kind === 'phase') {
    return `阶段 · ${physicalOperatorPhaseLabel(progress.phase)}`
  }
  if (progress.kind === 'public-output') return '公开输出更新'
  if (progress.kind === 'tool-started') {
    return `工具开始${progress.toolName === undefined ? '' : ` · ${progress.toolName}`}`
  }
  if (progress.kind === 'tool-completed') {
    return `工具完成${progress.toolName === undefined ? '' : ` · ${progress.toolName}`}`
  }
  if (progress.kind === 'approval-required') {
    return `需要批准${progress.approvalKind === undefined ? '' : ` · ${progress.approvalKind}`}`
  }
  const usage = progress.usage
  const fragments = [
    usage?.inputTokens === undefined ? undefined : `输入 ${String(usage.inputTokens)}`,
    usage?.outputTokens === undefined ? undefined : `输出 ${String(usage.outputTokens)}`,
  ].filter((value): value is string => value !== undefined)
  return fragments.length === 0 ? '用量更新' : `用量更新 · ${fragments.join(' · ')}`
}

function debateProgressDetails(
  progress: TrajectoryDebateProgress,
  route: string | undefined,
): string | undefined {
  const usage = progress.usage
  const usageLines = [
    usage?.inputTokens === undefined ? undefined : `- 输入：${String(usage.inputTokens)}`,
    usage?.outputTokens === undefined ? undefined : `- 输出：${String(usage.outputTokens)}`,
    usage?.cacheReadInputTokens === undefined ? undefined : `- 缓存命中：${String(usage.cacheReadInputTokens)}`,
    usage?.cacheWriteInputTokens === undefined ? undefined : `- 缓存写入：${String(usage.cacheWriteInputTokens)}`,
    usage?.costUsd === undefined ? undefined : `- 成本：$${usage.costUsd.toFixed(6)}`,
  ].filter((value): value is string => value !== undefined)
  const sections = [
    route === undefined ? undefined : `**模型路由**：${route}`,
    progress.phase === undefined ? undefined : `**执行阶段**：${physicalOperatorPhaseLabel(progress.phase)}`,
    progress.toolName === undefined ? undefined : `### 工具\n\n- ${progress.toolName}`,
    progress.approvalKind === undefined ? undefined : [
      '### 权限请求',
      '',
      `- 类型：${progress.approvalKind}`,
      ...(progress.approvalPreview === undefined ? [] : ['', progress.approvalPreview]),
    ].join('\n'),
    progress.publicOutputPreview === undefined ? undefined : `### 公开输出\n\n${progress.publicOutputPreview}`,
    usageLines.length === 0 ? undefined : `### 用量\n\n${usageLines.join('\n')}`,
  ].filter((value): value is string => value !== undefined)
  return sections.length === 0 ? undefined : sections.join('\n\n')
}

function debateRouteLabel(role: NonNullable<TrajectoryDebateTraceEntry['role']>): string {
  const requested = `${physicalOperatorLabel(role.requestedOperatorId)} / ${role.requestedModel}`
  if (role.actualOperatorId === undefined || role.actualModel === undefined) return requested
  const actual = `${physicalOperatorLabel(role.actualOperatorId)} / ${role.actualModel}`
  return requested === actual ? actual : `${requested} → ${actual}`
}

function debateStateLabel(state: string): string {
  return ({
    planned: '已创建',
    dispatched: '已派发',
    running: '讨论中',
    settled: '已提交观点',
    blocked: '等待批准',
    failed: '执行失败',
    indeterminate: '状态不确定',
    'round-completed': '本轮完成',
    'synthesis-running': '主持人整理中',
    'synthesis-settled': '主持人总结完成',
    'run-completed': '讨论完成',
    'budget-limited': '预算已到上限',
    'max-rounds': '达到轮次上限',
    stopped: '已停止',
  } as Record<string, string>)[state] ?? '状态已更新'
}

function debateDetails(
  entry: TrajectoryDebateTraceEntry,
  route: string | undefined,
): string | undefined {
  const sections = [
    route === undefined ? undefined : `**模型路由**：${route}`,
    entry.publicOutputRef === undefined ? undefined : `**结果引用**：${entry.publicOutputRef}`,
    entry.publicOutputPreview === undefined ? undefined : `### 公开观点\n\n${entry.publicOutputPreview}`,
    entry.claims.length === 0
      ? undefined
      : `### 本楼主张\n\n${entry.claims.map(claim => `- ${claim.statement}（${claim.status} · ${claim.severity}）`).join('\n')}`,
    entry.evidenceRefs.length === 0
      ? undefined
      : `### 证据\n\n${entry.evidenceRefs.map(ref => `- ${ref}`).join('\n')}`,
    entry.convergence === undefined
      ? undefined
      : `### 收敛判断\n\n- 状态：${entry.convergence.status}\n- 分数：${entry.convergence.score.toFixed(2)} / ${entry.convergence.threshold.toFixed(2)}\n- 原因：${entry.convergence.reason}`,
    entry.synthesis === undefined
      ? undefined
      : [
        '### 主持人总结',
        '',
        `- 状态：${entry.synthesis.state}`,
        `- 未解决问题：${String(entry.synthesis.unresolvedCount)}`,
        `- 保留异议：${String(entry.synthesis.dissentCount)}`,
        ...(entry.synthesis.artifactRef === undefined ? [] : [`- 结果引用：${entry.synthesis.artifactRef}`]),
        ...(entry.synthesis.outputPreview === undefined ? [] : ['', entry.synthesis.outputPreview]),
      ].join('\n'),
  ].filter((value): value is string => value !== undefined)
  return sections.length === 0 ? undefined : sections.join('\n\n')
}

function physicalOperatorPhaseLabel(phase: string | undefined): string {
  return ({
    connecting: '连接原生产品',
    'session-ready': '原生会话已接通',
    reasoning: '推理与执行',
    'tool-activity': '使用工具',
    finalizing: '整理结果',
  } as Record<string, string>)[phase ?? ''] ?? '正在执行'
}

function physicalOperatorShapeLabel(
  shape: NonNullable<TrajectoryPhysicalOperatorExecution['entries'][number]['tool']>['argumentsShape'] | undefined,
): string | undefined {
  if (shape === undefined) return undefined
  if (shape.kind === 'object') return `对象 · ${String(shape.fields)} 个字段`
  if (shape.kind === 'array') return `数组 · ${String(shape.items)} 项`
  if (shape.kind === 'string') return `文本 · ${String(shape.characters)} 字符`
  return ({
    number: '数字',
    boolean: '布尔值',
    null: '空值',
    unavailable: '结构不可用',
  } as Record<string, string>)[shape.kind]
}

/**
 * Append the changing in-flight assistant cells to a stable finalized layout.
 * @param turns - Finalized layout derived with an empty-block partial anchor.
 * @param partial - Current in-flight assistant projection.
 * @param lastIndex - Highest cell index in the finalized layout.
 * @returns The original layout without a partial, otherwise a layout sharing every unaffected turn.
 */
export function appendTrajectoryPartialLayout(
  turns: readonly TrajectoryTurnModel[],
  partial: ConversationSnapshot['partial'],
  lastIndex: number,
): readonly TrajectoryTurnModel[] {
  if (partial === null) return turns
  const partialTurn = deriveTrajectoryLayout({
    nodes: [],
    partial,
    runningCalls: [],
  }).at(0)
  if (partialTurn === undefined) return turns
  const streamed: TrajectoryTurnModel = {
    ...partialTurn,
    groups: partialTurn.groups.map(group => ({
      ...group,
      cells: group.cells.map(cell => ({ ...cell, index: cell.index + lastIndex })),
    })),
  }
  const turnIndex = turns.findIndex(turn => turn.turn === streamed.turn)
  if (turnIndex === -1) return [...turns, streamed]
  const current = turns[turnIndex]
  /* v8 ignore next -- findIndex proved the dense array position exists. */
  if (current === undefined) return turns
  const groups = [...current.groups]
  for (const streamedGroup of streamed.groups) {
    const groupIndex = groups.findIndex(group => group.title === streamedGroup.title)
    if (groupIndex === -1) {
      groups.push(streamedGroup)
      continue
    }
    const group = groups[groupIndex]
    /* v8 ignore next -- findIndex proved the dense array position exists. */
    if (group === undefined) continue
    const streamedCallIds = new Set(
      streamedGroup.cells.flatMap(cell => cell.callId === undefined ? [] : [cell.callId]),
    )
    groups[groupIndex] = {
      ...streamedGroup,
      cells: [
        ...group.cells.filter(cell =>
          cell.requestOnly !== true
          && (cell.callId === undefined || !streamedCallIds.has(cell.callId)),
        ),
        ...streamedGroup.cells,
      ],
    }
  }
  const updated = [...turns]
  updated[turnIndex] = { ...current, groups }
  return updated
}

function attachToolSchema(
  laid: LaidCell,
  callSchemas: RequestInspectionSnapshot['callSchemas'] | undefined,
): void {
  if (laid.callId === undefined || callSchemas === undefined) return
  const schema = callSchemas.get(laid.callId)
  if (schema === undefined) return
  laid.cell.schemaDetail = JSON.stringify(schema, null, 2)
}

function toTurnModel(
  turn: number | null,
  entry: TurnBucket,
): TrajectoryTurnModel {
  const groups = entry.groups.map(({ title, laid }): TrajectoryGroupModel => {
    const description = groupDescription(laid)
    return {
      title,
      ...(description !== undefined ? { description } : {}),
      cells: laid.map(l => l.cell),
    }
  })
  return { turn, groups }
}

/** Chronological section position from the fold's monotonically assigned cell indexes. */
function firstCellIndex(turn: TrajectoryTurnModel): number {
  return Math.min(
    ...turn.groups.flatMap(group => group.cells.map(cell => cell.index)),
    Number.POSITIVE_INFINITY,
  )
}

/** Wall-span duration + tool histogram, e.g. `1.5 s bash×6`. */
function groupDescription(laid: readonly LaidCell[]): string | undefined {
  const parts: string[] = []
  // Tool rows contribute start (absTime) and end (start + own duration) so a
  // single Tool cell still spans call→result for the group wall clock.
  const times: number[] = []
  for (const l of laid) {
    if (l.absTime === null || !Number.isFinite(l.absTime)) continue
    times.push(l.absTime)
    if (l.cell.kind === 'tool' && l.cell.timeSeconds !== null && Number.isFinite(l.cell.timeSeconds)) {
      times.push(l.absTime + l.cell.timeSeconds * 1000)
    }
  }
  if (times.length >= 2) {
    const span = formatGroupDuration((Math.max(...times) - Math.min(...times)) / 1000)
    if (span !== undefined) parts.push(span)
  } else if (times.length === 1) {
    const own = laid.find(l => l.absTime === times[0])?.cell.timeSeconds
    const span = own !== null && own !== undefined ? formatGroupDuration(own) : undefined
    if (span !== undefined) parts.push(span)
  }
  const tools = new Map<string, number>()
  for (const l of laid) {
    if (l.toolName === undefined || l.cell.kind !== 'tool') continue
    tools.set(l.toolName, (tools.get(l.toolName) ?? 0) + 1)
  }
  for (const [name, count] of tools) {
    parts.push(count > 1 ? `${name}×${count}` : name)
  }
  return parts.length === 0 ? undefined : parts.join(' ')
}

function formatGroupDuration(seconds: number): string | undefined {
  if (!Number.isFinite(seconds)) return undefined
  return formatElapsedSeconds(seconds)
}

/** Own-duration seconds from two epoch-ms stamps; null when either is unusable. */
function durationSeconds(later: number, earlier: number | null): number | null {
  if (earlier === null || !Number.isFinite(later) || !Number.isFinite(earlier)) return null
  return Math.max(0, (later - earlier) / 1000)
}

/** Epoch-ms usable as an absolute time, else null. */
function finiteTime(time: number | null | undefined): number | null {
  return typeof time === 'number' && Number.isFinite(time) ? time : null
}

function expandAssistant(
  node: AssistantMessageNode,
  startIndex: number,
  prevAbsTime: number | null,
  results: Map<string, ToolResultNode>,
  callStarts: ReadonlyMap<string, number>,
  calls: ReadonlyMap<string, ToolCallBlock>,
  opts?: { streaming?: boolean },
): LaidCell[] {
  if (opts?.streaming === true && node.blocks.length === 0) return []
  const out: LaidCell[] = []
  let index = startIndex - 1
  const usage = node.usage as UsageLike | undefined
  const streaming = opts?.streaming === true
  const recordedStart = finiteTime(node.timing?.stepStartTime)
  const messageDuration = streaming
    ? null
    : durationSeconds(node.time, recordedStart ?? prevAbsTime)
  const nodeAbs = streaming ? null : finiteTime(node.time)
  const messageText = node.blocks
    .filter(block => block.kind === 'text' && (!streaming || block.text !== ''))
    .map(block => block.kind === 'text' ? block.text : '')
    .join('\n\n')
  const thinkingText = node.blocks
    .filter(block => block.kind === 'reasoning' && (!streaming || block.text !== ''))
    .map(block => block.kind === 'reasoning' ? block.text : '')
    .join('\n\n')
  const message: TrajectoryCellProps = {
    index: ++index,
    recordId: `assistant\u0000${node.turn}\u0000${node.step}`,
    kind: 'message',
    sourceSeq: node.seq,
    text: messageText !== '' || thinkingText !== ''
      ? ''
      : summarizeAssistantActivity(node.blocks),
    ...(messageText !== ''
      ? { previewMarkdown: messageText }
      : thinkingText !== ''
        ? { previewMarkdown: thinkingText }
        : {}),
    ...(messageText !== '' ? { outputDetail: messageText } : {}),
    ...(thinkingText !== '' ? { thinkingDetail: thinkingText } : {}),
    sourceBlocks: node.blocks.map(block => assistantSourceBlock(block)),
    timeSeconds: messageDuration,
    startedAt: recordedStart,
  }
  attachUsage(message, usage)
  message.assistantMetrics = {
    timingRecorded: node.timing !== undefined,
    stepStartTime: node.timing?.stepStartTime ?? null,
    firstTokenTime: node.timing?.firstTokenTime ?? null,
    completedTime: streaming ? null : finiteTime(node.time),
    usageProvided: usage !== undefined,
    outputTokens: Number.isFinite(usage?.outputTokens) ? usage?.outputTokens ?? null : null,
  }
  out.push({ absTime: nodeAbs, cell: message })

  for (const block of node.blocks) {
    // Text and reasoning belong to the one Assistant record emitted above.
    if (block.kind !== 'tool-call') continue
    const result = results.get(block.callId)
    const toolDuration = streaming || result === undefined
      ? null
      : durationSeconds(result.time, result.callTime)
    const callAbs = finiteTime(callStarts.get(block.callId))
    const call = calls.get(block.callId)
    const resultPreview = result === undefined ? undefined : summarizeResult(result)
    out.push({
      absTime: callAbs,
      toolName: block.name,
      callId: block.callId,
      ...(call === undefined ? {} : { subCalls: call.subCalls }),
      cell: {
        index: ++index, kind: 'tool',
        ...summarizeCall(block.name, block.argsRaw),
        inputDetail: block.argsRaw,
        callId: block.callId,
        ...(result !== undefined
          ? {
            outputDetail: detailResult(result),
            outputBlocks: result.content.map(block => sourceBlock(block)),
            ...resultPreview,
            isError: result.isError,
          }
          : {}),
        timeSeconds: toolDuration,
        startedAt: callAbs,
      },
    })
  }
  return out
}

function summarizeAssistantActivity(blocks: readonly AssistantBlock[]): string {
  const tools = new Map<string, number>()
  for (const block of blocks) {
    if (block.kind !== 'tool-call') continue
    tools.set(block.name, (tools.get(block.name) ?? 0) + 1)
  }
  if (tools.size > 0) {
    return 'Tool call only'
  }
  return ''
}

function promptChangeLabel(change: RequestPromptChange): string {
  if (change.kind === 'initial') return 'Initial System Prompt'
  if (change.kind === 'system') return 'System Prompt Updated'
  if (change.kind === 'tools') return 'Tools Updated'
  return 'System Prompt and Tools Updated'
}

function assistantSourceBlock(block: AssistantBlock): TrajectorySourceBlock {
  switch (block.kind) {
    case 'text': return { type: 'text', content: block.text }
    case 'reasoning': return { type: 'thinking', content: block.text }
    case 'tool-call': return {
      type: 'tool-call',
      content: block.argsRaw,
      callId: block.callId,
      toolName: block.name,
    }
    // Attachment refs carry no fetchable bytes, so the record shows the
    // durable metadata instead of an inline preview.
    case 'image': return {
      type: 'image',
      content: stringifySourceValue(block.attachment),
    }
    case 'other': return sourceBlock(block.block)
  }
}

function sourceBlock(value: unknown): TrajectorySourceBlock {
  if (typeof value !== 'object' || value === null) {
    return { type: 'unknown', content: stringifySourceValue(value) }
  }
  const block = value as Record<string, unknown>
  const type = typeof block.type === 'string' ? block.type : 'unknown'
  if (typeof block.text === 'string') {
    return { type: type === 'reasoning' ? 'thinking' : type, content: block.text }
  }
  const imageSrc = sourceImage(block)
  const imageAlt = typeof block.alt === 'string' ? block.alt : undefined
  return {
    type,
    content: imageSrc === undefined ? stringifySourceValue(value) : '',
    ...(imageSrc !== undefined ? { imageSrc } : {}),
    ...(imageAlt !== undefined ? { imageAlt } : {}),
  }
}

function sourceImage(block: Record<string, unknown>): string | undefined {
  if (typeof block.type !== 'string' || !block.type.toLowerCase().includes('image')) return undefined
  for (const candidate of [block.url, block.image_url]) {
    if (typeof candidate === 'string') return safeImageSource(candidate)
  }
  if (typeof block.data === 'string') {
    const mediaType = [block.mimeType, block.mediaType, block.media_type]
      .find((candidate): candidate is string => typeof candidate === 'string')
      ?? 'image/png'
    return safeImageSource(
      block.data.startsWith('data:')
        ? block.data
        : `data:${mediaType};base64,${block.data}`,
    )
  }
  if (typeof block.source !== 'object' || block.source === null) return undefined
  const source = block.source as Record<string, unknown>
  if (typeof source.url === 'string') return safeImageSource(source.url)
  if (typeof source.data !== 'string') return undefined
  const mediaType = typeof source.media_type === 'string' ? source.media_type : 'image/png'
  return safeImageSource(`data:${mediaType};base64,${source.data}`)
}

function safeImageSource(value: string): string | undefined {
  if (value.startsWith('data:image/') || value.startsWith('blob:')) return value
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:' ? value : undefined
  } catch {
    return undefined
  }
}

function stringifySourceValue(value: unknown): string {
  const json = JSON.stringify(value, null, 2)
  return json || String(value)
}

/**
 * Turn that encloses a user/message: next assistant turn, else the
 * in-flight partial, else the turn after the last finalized assistant (or 1).
 */
function enclosingUserTurn(
  followingAssistant: AssistantMessageNode | undefined,
  partial: ConversationSnapshot['partial'],
  lastAssistantTurn: number | null,
): number {
  if (followingAssistant !== undefined) return followingAssistant.turn
  if (partial !== null) return partial.turn
  if (lastAssistantTurn !== null) return lastAssistantTurn + 1
  return 1
}

function steeringPlacement(
  followingAssistant: AssistantMessageNode | undefined,
  partial: ConversationSnapshot['partial'],
  lastAssistantTurn: number | null,
  location: ConversationLocation | undefined,
): { turn: number; step?: number } {
  if (location?.kind === 'step') {
    return { turn: location.turn.turn, step: location.step.step }
  }
  const locatedTurn = location?.kind === 'turn' ? location.turn.turn : undefined
  if (followingAssistant !== undefined
    && (locatedTurn === undefined || followingAssistant.turn === locatedTurn)) {
    return {
      turn: followingAssistant.turn,
      ...(followingAssistant.step > 0 ? { step: followingAssistant.step } : {}),
    }
  }
  if (partial !== null && (locatedTurn === undefined || partial.turn === locatedTurn)) {
    return { turn: partial.turn, ...(partial.step > 0 ? { step: partial.step } : {}) }
  }
  if (locatedTurn !== undefined) return { turn: locatedTurn }
  return { turn: lastAssistantTurn ?? 1 }
}

function indexFollowingAssistants(
  nodes: ConversationSnapshot['nodes'],
): readonly (AssistantMessageNode | undefined)[] {
  const following = new Array<AssistantMessageNode | undefined>(nodes.length)
  let assistant: AssistantMessageNode | undefined
  for (let index = nodes.length - 1; index >= 0; index--) {
    following[index] = assistant
    const node = nodes[index]
    if (node?.kind === 'assistant') assistant = node
  }
  return following
}

function enclosingPromptTurn(
  nodes: ConversationSnapshot['nodes'],
  seq: number,
  partial: ConversationSnapshot['partial'],
): number {
  const next = nodes.find(node =>
    node.seq > seq && node.kind === 'assistant' && node.step > 0)
  if (next?.kind === 'assistant') return next.turn
  return partial?.turn ?? 1
}

/** Earliest raw turn represented by the selected trajectory branch. */
function firstVisibleTurn(
  nodes: ConversationSnapshot['nodes'],
  partial: ConversationSnapshot['partial'],
): number {
  const turns = nodes.flatMap(node =>
    node.kind === 'assistant' && node.turn > 0
      ? [node.turn]
      : [],
  )
  if (partial !== null && partial.turn > 0) turns.push(partial.turn)
  return turns.length === 0 ? 1 : Math.min(...turns)
}

/** Copy provider usage onto a Message cell when present. */
function attachUsage(cell: TrajectoryCellProps, usage: UsageLike | undefined): void {
  if (usage === undefined) return
  if (usage.inputTokens !== undefined) cell.input = usage.inputTokens
  if (usage.cacheReadTokens !== undefined) cell.cacheRead = usage.cacheReadTokens
  if (usage.cacheWriteTokens !== undefined) cell.cacheWrite = usage.cacheWriteTokens
  if (usage.outputTokens !== undefined) cell.output = usage.outputTokens
  if (usage.reasoningTokens !== undefined) cell.think = usage.reasoningTokens
}

function indexResults(nodes: ConversationSnapshot['nodes']): Map<string, ToolResultNode> {
  const map = new Map<string, ToolResultNode>()
  for (const node of nodes) {
    if (node.kind === 'tool-result') map.set(node.callId, node)
  }
  return map
}

function indexAssistantCallIds(nodes: ConversationSnapshot['nodes']): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const node of nodes) {
    if (node.kind !== 'assistant') continue
    for (const block of node.blocks) {
      if (block.kind === 'tool-call') ids.add(block.callId)
    }
  }
  return ids
}

function collectCallIds(
  turns: Map<number, TurnBucket>,
): Set<string> {
  const ids = new Set<string>()
  for (const entry of turns.values()) {
    for (const group of entry.groups) {
      for (const laid of group.laid) {
        if (laid.callId !== undefined) ids.add(laid.callId)
      }
    }
  }
  return ids
}



/** Interleave each tool cell's nested child calls right after it, reindexing followers. */
function withSubCalls(laidList: LaidCell[]): LaidCell[] {
  if (!laidList.some(laid => laid.subCalls !== undefined && laid.subCalls.length > 0)) return laidList
  const out: LaidCell[] = []
  let index = laidList[0] !== undefined ? laidList[0].cell.index - 1 : 0
  for (const laid of laidList) {
    out.push({ ...laid, cell: { ...laid.cell, index: ++index } })
    for (const sub of expandSubCalls(laid.subCalls, index)) {
      out.push(sub)
      index = sub.cell.index
    }
  }
  return out
}

/** Sub-dispatch cells for one run_code parent, in start order (running = null duration). */
function expandSubCalls(
  subs: readonly ToolCallBlock[] | undefined,
  startIndex: number,
): LaidCell[] {
  if (subs === undefined || subs.length === 0) return []
  const out: LaidCell[] = []
  let index = startIndex
  for (const sub of subs) {
    const settled = 'kind' in sub
    const resultPreview = settled ? summarizeResult(sub) : undefined
    const laid: LaidCell = {
      absTime: settled ? finiteTime(sub.callTime ?? sub.time) : finiteTime(sub.time),
      toolName: settled ? sub.call?.name ?? sub.callId : sub.name,
      callId: sub.callId,
      cell: {
        index: ++index,
        kind: 'subtool',
        callId: sub.callId,
        ...(settled
          ? (sub.call !== null
            ? summarizeCall(sub.call.name, sub.call.argsRaw)
            : resultAsText(resultPreview))
          : summarizeCall(sub.name, sub.argsRaw)),
        ...(settled
          ? (sub.call !== null ? { inputDetail: sub.call.argsRaw } : {})
          : { inputDetail: sub.argsRaw }),
        ...(settled
          ? {
            outputDetail: detailResult(sub),
            outputBlocks: sub.content.map(block => sourceBlock(block)),
            ...resultPreview,
            isError: sub.isError,
          }
          : {}),
        // The code-dispatch start/settle pair carries per-sub-call wall time;
        // a running (unsettled) or pre-pair log entry shows the em dash.
        timeSeconds: settled ? durationSeconds(sub.time, sub.callTime) : null,
        startedAt: settled
          ? finiteTime(sub.callTime)
          : finiteTime(sub.time),
      },
    }
    out.push(laid)
    for (const child of expandSubCalls(sub.subCalls, index)) {
      out.push(child)
      index = child.cell.index
    }
  }
  return out
}

function summarizeCall(
  name: string,
  argsRaw: string,
): Pick<TrajectoryCellProps, 'text' | 'previewMarkdown'> {
  return {
    text: name,
    ...(argsRaw === '' ? {} : { previewMarkdown: argsRaw }),
  }
}

function summarizeResult(
  node: ToolResultNode,
): Pick<TrajectoryCellProps, 'result' | 'resultPreviewMarkdown'> {
  if (node.isError) {
    return { result: node.error?.code ?? 'error' }
  }
  for (const block of node.content) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
      return { result: '', resultPreviewMarkdown: block.text }
    }
  }
  return { result: 'No output' }
}

function resultAsText(
  result: Pick<TrajectoryCellProps, 'result' | 'resultPreviewMarkdown'> | undefined,
): Pick<TrajectoryCellProps, 'text' | 'previewMarkdown'> {
  return {
    text: result?.result ?? '',
    ...(result?.resultPreviewMarkdown === undefined
      ? {}
      : { previewMarkdown: result.resultPreviewMarkdown }),
  }
}

function detailResult(node: ToolResultNode): string {
  if (node.isError) {
    return node.error === undefined
      ? 'error'
      : `${node.error.name}: ${node.error.code}`
  }
  const text = node.content
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.type === 'text' ? block.text : '')
    .join('\n')
  if (text !== '') return text
  if (
    node.content.length === 0
    || node.content.every(block =>
      block.type === 'text' && (typeof block.text !== 'string' || block.text === ''))
  ) return 'No output'
  return JSON.stringify(node.content, null, 2)
}

function detailContent(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text ?? '')
    .join('\n')
}

function detailReasoning(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter(block => block.type === 'reasoning' && typeof block.text === 'string')
    .map(block => block.text ?? '')
    .join('\n')
}

function previewContent(
  content: readonly { type: string; text?: string }[],
): string | undefined {
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') return block.text
  }
  return undefined
}

function previewContentProperty(
  content: readonly { type: string; text?: string }[],
): Pick<TrajectoryCellProps, 'previewMarkdown'> {
  const previewMarkdown = previewContent(content)
  return previewMarkdown === undefined ? {} : { previewMarkdown }
}
