import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'

import type {
  CollaborationModeState,
  StudioDraft,
  StudioIssue,
  StudioOverview,
  StudioRun,
  StudioRunRecord,
  StudioSource,
  StudioUiApi,
} from './studio-contract.js'

const identifier = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const uuid = z.uuid()
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

const overviewSchema = z.strictObject({ sessionId: identifier })
const refreshSourceSchema = z.strictObject({ sessionId: identifier, sourceId: identifier })
const saveSchema = z.strictObject({
  sessionId: identifier,
  id: uuid,
  expectedRevision: revision,
  graph: z.unknown(),
  sourceId: identifier.optional(),
})
const validateSchema = z.strictObject({ sessionId: identifier, graph: z.unknown() })
const runSchema = z.strictObject({ sessionId: identifier, draftId: uuid, expectedRevision: revision, commandId: identifier })
const inspectSchema = z.strictObject({ sessionId: identifier, commandId: identifier })
const resumeSchema = z.strictObject({ sessionId: identifier, commandId: identifier, sourceId: identifier.optional() })
const modeSchema = z.strictObject({ sessionId: identifier, mode: z.enum(['ordinary', 'smart']), expectedRevision: revision })

/** Owner-only Typert boundary for the shared editor. It has no model route. */
export class StudioControl extends TypertRemoteService implements StudioUiApi {
  constructor(ctx: Context, private readonly studio: StudioUiApi) {
    super(ctx, 'solarWorkflowControl')
  }

  private owner(): void {
    const invocation = this.ctx.invocation
    if (invocation !== undefined && invocation.peer.principal.kind !== 'owner') {
      throw new Error('LOCAL_OWNER_REQUIRED: 流程编辑界面仅允许本机所有者操作。')
    }
  }

  @Remote
  async overview(input: unknown): Promise<StudioOverview> {
    this.owner()
    return this.studio.overview(overviewSchema.parse(input))
  }

  @Remote
  async refreshSource(input: unknown): Promise<StudioSource> {
    this.owner()
    return this.studio.refreshSource(refreshSourceSchema.parse(input))
  }

  @Remote
  async save(input: unknown): Promise<StudioDraft> {
    this.owner()
    const value = saveSchema.parse(input)
    return this.studio.save({ ...value, graph: value.graph as never })
  }

  @Remote
  async validate(input: unknown): Promise<readonly StudioIssue[]> {
    this.owner()
    const value = validateSchema.parse(input)
    return this.studio.validate({ ...value, graph: value.graph as never })
  }

  @Remote
  async run(input: unknown): Promise<StudioRunRecord> {
    this.owner()
    return this.studio.run(runSchema.parse(input))
  }

  @Remote
  async inspect(input: unknown): Promise<StudioRunRecord> {
    this.owner()
    return this.studio.inspect(inspectSchema.parse(input))
  }

  @Remote
  async resume(input: unknown): Promise<StudioRun> {
    this.owner()
    return this.studio.resume(resumeSchema.parse(input))
  }

  @Remote
  async setMode(input: unknown): Promise<CollaborationModeState> {
    this.owner()
    return this.studio.setMode(modeSchema.parse(input))
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    solarWorkflowControl: StudioControl
  }
}
