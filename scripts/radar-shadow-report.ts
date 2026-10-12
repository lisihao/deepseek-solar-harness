/**
 * Report what Smart Collaboration did with Radar evidence and cost-aware selection in real DSH sessions.
 * It reads the `physical-operator/routing-decision` events of the session logs, so the numbers come from
 * what happened, not from a replay. In `shadow` mode the report shows what the selection preferred and what
 * that would have changed; it does not show whether the preferred model would have finished the work.
 * @module scripts/radar-shadow-report
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { scanZstdFrames } from '../packages/session/session-persistence-jsonl/src/zstd.ts'

/** The measured facts of one offer, as the routing-decision event records them. */
export interface OfferMeasurement {
  passRate: number
  avgCostUsd: number
  avgRuntimeSeconds: number
  sampleCount: number
}

/** The routing-decision fields this report reads (`RoutingAllocationSummary` in tool-physical-operator). */
export interface AllocationFacts {
  difficulty: 'easy' | 'normal' | 'hard'
  chosenOfferId: string
  selection?: {
    mode: 'shadow' | 'apply'
    status: 'used' | 'abstained'
    objective: string
    applied: boolean
    baselineOfferId: string
    selectedOfferId: string
    selected?: OfferMeasurement
    baseline?: OfferMeasurement
  }
  evidence?: { mode: 'shadow' | 'apply'; status: 'used' | 'abstained'; applied: boolean }
}

/** One session event; only the fields the report reads. */
export interface ReportEvent {
  type: string
  time?: number
  data?: Record<string, unknown>
}

/** Totals of one report window. */
export interface ShadowReport {
  readonly decisions: number
  readonly byRoute: Readonly<Record<string, number>>
  /** Decisions made by the allocator, which is where Radar evidence can matter. */
  readonly allocated: number
  readonly byDifficulty: Readonly<Record<string, number>>
  readonly selection: {
    readonly ran: number
    readonly abstained: number
    /** The selection preferred an offer other than the baseline. */
    readonly differs: number
    /** The preferred offer replaced the baseline in the dispatched work. */
    readonly applied: number
    /** Differing selections whose baseline and preferred offer both have measurements. */
    readonly comparable: number
    readonly avgCostDeltaUsd: number | undefined
    readonly avgRuntimeDeltaSeconds: number | undefined
    readonly avgPassRateDelta: number | undefined
  }
  readonly evidence: { readonly ran: number; readonly used: number; readonly applied: number }
  /** Allocated requests whose delegated run ended in a recorded failure, by difficulty. */
  readonly failures: Readonly<Record<string, { readonly allocated: number; readonly failed: number }>>
  readonly rows: readonly string[]
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1
}

function mean(values: readonly number[]): number | undefined {
  return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length
}

/**
 * Summarize routing decisions that happened at or after `sinceMs`.
 * @param events - session events of every session in the window.
 * @param sinceMs - earliest event time, in epoch milliseconds.
 * @returns totals and one readable row per allocator decision.
 */
export function summarize(events: readonly ReportEvent[], sinceMs: number): ShadowReport {
  const inWindow = events.filter(event => (event.time ?? 0) >= sinceMs)
  const decisions = inWindow.filter(event => event.type === 'physical-operator/routing-decision')
  const dispatchByMessage = new Map<string, string>()
  for (const event of inWindow) {
    if (event.type === 'physical-operator/dispatch') {
      dispatchByMessage.set(String(event.data?.requestedByMessageId), String(event.data?.commandId))
    }
  }
  const failedCommands = new Set(inWindow
    .filter(event => event.type === 'physical-operator/dispatch-terminal')
    .map(event => String(event.data?.commandId)))

  const byRoute: Record<string, number> = {}
  const byDifficulty: Record<string, number> = {}
  const failures: Record<string, { allocated: number; failed: number }> = {}
  const rows: string[] = []
  const costDeltas: number[] = []
  const runtimeDeltas: number[] = []
  const passDeltas: number[] = []
  let allocated = 0
  const selection = { ran: 0, abstained: 0, differs: 0, applied: 0, comparable: 0 }
  const evidence = { ran: 0, used: 0, applied: 0 }

  for (const event of decisions) {
    const data = event.data ?? {}
    bump(byRoute, `${String(data.policy)}/${String(data.route)}`)
    const facts = data.allocation as AllocationFacts | undefined
    if (facts === undefined) continue
    allocated += 1
    bump(byDifficulty, facts.difficulty)
    const bucket = failures[facts.difficulty] ?? { allocated: 0, failed: 0 }
    bucket.allocated += 1
    const commandId = dispatchByMessage.get(String(data.requestedByMessageId))
    const failed = commandId !== undefined && failedCommands.has(commandId)
    if (failed) bucket.failed += 1
    failures[facts.difficulty] = bucket
    if (facts.evidence !== undefined) {
      evidence.ran += 1
      if (facts.evidence.status === 'used') evidence.used += 1
      if (facts.evidence.applied) evidence.applied += 1
    }
    const chosen = facts.selection
    let verdict = 'no cost-aware selection'
    if (chosen !== undefined) {
      selection.ran += 1
      if (chosen.status === 'abstained') {
        selection.abstained += 1
        verdict = 'abstained'
      } else {
        const differs = chosen.selectedOfferId !== chosen.baselineOfferId
        if (differs) selection.differs += 1
        if (chosen.applied) selection.applied += 1
        verdict = differs ? `${chosen.mode} prefers ${chosen.selectedOfferId}` : 'agrees with the baseline'
        if (differs && chosen.selected !== undefined && chosen.baseline !== undefined) {
          selection.comparable += 1
          costDeltas.push(chosen.selected.avgCostUsd - chosen.baseline.avgCostUsd)
          runtimeDeltas.push(chosen.selected.avgRuntimeSeconds - chosen.baseline.avgRuntimeSeconds)
          passDeltas.push(chosen.selected.passRate - chosen.baseline.passRate)
        }
      }
    }
    const when = event.time === undefined ? '' : new Date(event.time).toISOString().slice(0, 16).replace('T', ' ')
    rows.push(`${when} | ${facts.difficulty} | baseline ${chosen?.baselineOfferId ?? facts.chosenOfferId} | ran ${facts.chosenOfferId} | ${verdict}${failed ? ' | run failed' : ''}`)
  }

  return {
    decisions: decisions.length,
    byRoute,
    allocated,
    byDifficulty,
    selection: {
      ...selection,
      avgCostDeltaUsd: mean(costDeltas),
      avgRuntimeDeltaSeconds: mean(runtimeDeltas),
      avgPassRateDelta: mean(passDeltas),
    },
    evidence,
    failures,
    rows,
  }
}

function sign(value: number): string {
  return value > 0 ? `+${value.toFixed(2)}` : value.toFixed(2)
}

/**
 * Render a report as Markdown.
 * @param report - totals from {@link summarize}.
 * @param sinceIso - start of the window, for the heading.
 * @returns Markdown text.
 */
export function renderReport(report: ShadowReport, sinceIso: string): string {
  const out = [`# Smart Collaboration shadow report (since ${sinceIso})`, '']
  out.push(`Routing decisions: ${String(report.decisions)}; allocator decisions (where Radar evidence can matter): ${String(report.allocated)}.`)
  out.push('', '## Routes', ...Object.entries(report.byRoute).map(([key, count]) => `- ${key}: ${String(count)}`))
  if (report.allocated === 0) {
    out.push('', 'No allocator decision in this window yet: nothing to evaluate. Use Smart Collaboration for coding or analysis requests, then run this again.')
    return `${out.join('\n')}\n`
  }
  out.push('', '## Difficulty', ...Object.entries(report.byDifficulty).map(([key, count]) => `- ${key}: ${String(count)}`))
  const { selection, evidence } = report
  out.push('', '## Cost-aware selection',
    `- ran ${String(selection.ran)} times; abstained ${String(selection.abstained)}; preferred a different offer than the baseline ${String(selection.differs)}; replaced the baseline in the dispatched work ${String(selection.applied)}`)
  if (selection.comparable === 0) {
    out.push('- no differing choice has measurements for both the baseline and the preferred offer, so no cost or time difference can be computed from the data')
  } else {
    out.push(`- over the ${String(selection.comparable)} differing choices with both measurements, Radar's averages say: cost ${sign(selection.avgCostDeltaUsd ?? 0)} USD, runtime ${sign((selection.avgRuntimeDeltaSeconds ?? 0) / 60)} min, pass rate ${sign((selection.avgPassRateDelta ?? 0) * 100)} points per task (Radar's API-price equivalent, not your bill)`)
  }
  out.push('', '## Public-evidence tie-break', `- ran ${String(evidence.ran)} times; separated tied offers ${String(evidence.used)}; applied ${String(evidence.applied)}`)
  out.push('', '## Delegated runs that ended in a recorded failure',
    ...Object.entries(report.failures).map(([key, value]) => `- ${key}: ${String(value.failed)} of ${String(value.allocated)}`),
    '', 'A failure here is a run that ended without an answer. It does not measure whether finished work was correct.')
  out.push('', '## Decisions', ...report.rows.map(row => `- ${row}`))
  return `${out.join('\n')}\n`
}

/**
 * Decode a session log. A `.zstd` log is one frame per appended batch, and `zstdDecompressSync` stops
 * after the first frame, so every complete frame is decoded in turn; an incomplete final frame is skipped.
 * @param bytes - file contents.
 * @param compressed - whether the file is a concatenated-frame `.zstd` log.
 * @returns the log text.
 */
export function decodeLog(bytes: Buffer, compressed: boolean): string {
  if (!compressed) return bytes.toString('utf8')
  return scanZstdFrames(bytes).frames.map(({ start, end }) => zstdDecompressSync(bytes.subarray(start, end)).toString('utf8')).join('')
}

function readEvents(root: string, sinceMs: number): ReportEvent[] {
  const events: ReportEvent[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) { walk(path); continue }
      if (!/session\.jsonl(?:\.zstd)?$/u.test(entry.name) || statSync(path).mtimeMs < sinceMs) continue
      const text = decodeLog(readFileSync(path), entry.name.endsWith('.zstd'))
      for (const line of text.split('\n')) {
        if (!line.includes('"physical-operator/')) continue
        events.push(JSON.parse(line) as ReportEvent)
      }
    }
  }
  walk(root)
  return events
}

const invoked = process.argv[1]
if (invoked !== undefined && import.meta.filename === invoked) {
  const args = process.argv.slice(2)
  const option = (name: string): string | undefined => {
    const index = args.indexOf(name)
    return index < 0 ? undefined : args[index + 1]
  }
  const since = option('--since') ?? new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)
  const root = option('--sessions') ?? join(homedir(), '.dsh', 'sessions')
  const sinceMs = Date.parse(since)
  if (Number.isNaN(sinceMs)) throw new Error(`radar-shadow-report: --since must be a date, received ${since}`)
  process.stdout.write(renderReport(summarize(readEvents(root, sinceMs), sinceMs), since))
}
