/** Registry Provider for the collaboration kinds the kennel dispatcher can offer. */
import { Service, type Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { RESERVED_COLLABORATION_KINDS, type KennelCollaborationKind, type KennelCollaborations } from '@deepseek-ai/dsh-orchestration'

/** Holds registered kinds; each kind lives and is removed with the plugin that registered it. */
export class KennelCollaborationRegistry extends Service implements KennelCollaborations {
  private readonly registered: KennelCollaborationKind[] = []

  constructor(ctx: Context) {
    super(ctx, 'kennelCollaborations')
  }

  register(kind: KennelCollaborationKind): () => void {
    if (RESERVED_COLLABORATION_KINDS.includes(kind.kind)) {
      throw new HarnessError(`协作类型名「${kind.kind}」是调度器保留的。`, 'KENNEL_COLLABORATION_RESERVED')
    }
    if (this.registered.some(value => value.kind === kind.kind)) {
      throw new HarnessError(`协作类型「${kind.kind}」已注册。`, 'KENNEL_COLLABORATION_DUPLICATE')
    }
    this.registered.push(kind)
    return () => {
      const index = this.registered.indexOf(kind)
      if (index >= 0) this.registered.splice(index, 1)
    }
  }

  kinds(): readonly KennelCollaborationKind[] {
    return [...this.registered]
  }
}
