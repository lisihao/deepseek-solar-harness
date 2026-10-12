/** Defaults that every Consumer shares when it composes a Debate policy. */

import type {
  DebateBudgetV1,
  DebateConvergencePolicyV1,
  DebateRoleId,
  DebateRolePersonaV1,
  DebateRoundStrategyV1,
} from './types.ts'

/** Input tokens reserved for each roster participant in each planned round. */
const INPUT_TOKENS_PER_PARTICIPANT_PER_ROUND = 100_000
/** Output tokens reserved for each roster participant in each planned round. */
const OUTPUT_TOKENS_PER_PARTICIPANT_PER_ROUND = 15_000

function persona(
  title: string,
  mandate: string,
  stance: string,
  instructions: readonly [string, string],
): DebateRolePersonaV1 {
  return Object.freeze({ title, mandate, stance, instructions: Object.freeze([...instructions]) })
}

/** The persona of each fixed role: independent advocates, an evidence auditor, and a judge. */
export const DEFAULT_DEBATE_PERSONAS: Readonly<Record<DebateRoleId, DebateRolePersonaV1>> = Object.freeze({
  'constructive-proposer': persona(
    'Constructive Proposer',
    'Build the strongest practical answer to the user objective.',
    'Constructive, concrete, and explicit about assumptions.',
    [
      'Present a compact position with testable claims and implementation consequences.',
      'Use source references when available and identify the highest-impact uncertainty.',
    ],
  ),
  'skeptical-falsifier': persona(
    'Skeptical Falsifier',
    'Find decisive counterexamples, hidden assumptions, and failure modes.',
    'Skeptical without becoming contrarian or speculative.',
    [
      'Attack claims rather than personalities and rank objections by decision impact.',
      'Distinguish observed contradictions from uncertainties needing evidence.',
    ],
  ),
  'evidence-auditor': persona(
    'Evidence Auditor',
    'Check whether important claims are supported, traceable, and decision-relevant.',
    'Evidence-first and precise about what is not established.',
    [
      'Map each material claim to an available source or mark the evidence gap.',
      'Reject citations or artifacts that do not directly support the associated claim.',
    ],
  ),
  'decision-judge': persona(
    'Decision Judge',
    'Reconcile the strongest supported claims and preserve material dissent.',
    'Decisive when evidence permits and explicit when it does not.',
    [
      'Judge the shared claim ledger after participant outputs, not by model reputation.',
      'State the decision, unresolved blockers, minority view, and conditions that would change it.',
    ],
  ),
})

/** Independent first drafts, then ledger-focused follow-up rounds. */
export const DEFAULT_DEBATE_ROUNDS: DebateRoundStrategyV1 = Object.freeze({
  version: 1,
  firstRound: 'blind-independent',
  followUp: 'claim-ledger',
  escalation: 'high-severity-unresolved',
})

/** Stop early when three agents settle with every critical claim evidenced and no high-severity item open. */
export const DEFAULT_DEBATE_CONVERGENCE: DebateConvergencePolicyV1 = Object.freeze({
  version: 1,
  scoreThreshold: 0.82,
  minSettledAgents: 3,
  maxUnresolvedHighSeverity: 0,
  requireEvidenceForCritical: true,
  earlyStop: true,
})

/**
 * Derive the token and turn ceilings for a planned depth and roster size.
 * @param maxRounds - planned number of numbered rounds.
 * @param participantCount - roster slots that take a turn each round, including the judge.
 * @returns a budget whose token ceilings are upper bounds, not consumption targets.
 */
export function defaultDebateBudget(maxRounds: 1 | 2 | 3 | 4, participantCount: number): DebateBudgetV1 {
  const roundParticipants = maxRounds * participantCount
  const maxInputTokens = roundParticipants * INPUT_TOKENS_PER_PARTICIPANT_PER_ROUND
  const maxOutputTokens = roundParticipants * OUTPUT_TOKENS_PER_PARTICIPANT_PER_ROUND
  return {
    version: 1,
    maxRounds,
    maxTurnsPerAgent: maxRounds,
    maxAgentsPerRound: participantCount,
    maxInputTokens,
    maxOutputTokens,
    maxTotalTokens: maxInputTokens + maxOutputTokens,
  }
}
