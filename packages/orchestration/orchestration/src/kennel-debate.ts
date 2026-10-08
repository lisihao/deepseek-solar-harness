/** Host start of a Debate whose roster is a set of kennel members. */
import type { GouziId } from './gouzi.ts'
import type { OrchestrationRuntimeContextV1 } from './index.ts'

/** One kennel member a Debate runs on, with the execution entry and model the Host confirmed for it. */
export interface KennelDebateMember {
  readonly gouziId: GouziId
  readonly name: string
  /** Full registered execution entry, `gouzi.<gouziId>.<operator>`. */
  readonly operatorId: string
  /** Native model the member's entry runs for this Debate. */
  readonly model: string
}

/** A Debate request from a kennel Session. */
export interface KennelDebateRequest {
  /** Idempotent command identity; repeating it returns the run it started. */
  readonly commandId: string
  /** Kennel Session whose room shows the Debate's tasks. */
  readonly sessionId: string
  /** Workspace every member holds. */
  readonly workspace: string
  /** The question or objective the members argue. */
  readonly prompt: string
  /** Distinct members, one roster slot each, ordered by the roles the Provider assigns. */
  readonly members: readonly KennelDebateMember[]
  /** Request-time dynamic contexts captured from the Session. */
  readonly runtimeContext?: OrchestrationRuntimeContextV1
}

/** Which Debate role a member holds. */
export interface KennelDebateAssignment {
  readonly gouziId: GouziId
  /** Debate role identifier, such as `decision-judge`. */
  readonly role: string
}

/** A started Debate. */
export interface KennelDebateRun {
  readonly runId: string
  readonly assignments: readonly KennelDebateAssignment[]
}

/** Starts Debates over kennel members; the Debate Provider owns roles, budget, and rounds. */
export interface KennelDebateStarter {
  /** Fewest distinct members a Debate needs for an independent judge. */
  readonly minMembers: number
  /** Most distinct members the Debate roles can hold. */
  readonly maxMembers: number
  /**
   * Start and approve a Debate. The request is the user's explicit choice, so the run is approved at once; the
   * rounds then run in the background and their state is read from the Debate and the room.
   * @param request - members, workspace, and objective.
   * @returns the run and each member's role.
   */
  start(request: KennelDebateRequest): Promise<KennelDebateRun>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    kennelDebates: KennelDebateStarter
  }
}
