/** Parse actual Driver observations at the durable and transport JSON inputs. */
import { ResearchActionError, type ResearchDriverQualification, type ResearchDriverSelection,
  type ResearchObservedEffort } from '@deepseek-ai/dsh-research-handoff/api'

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ResearchActionError('invalid qualification object', 'FORMAT')
  }
  return value as Record<string, unknown>
}

function string(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new ResearchActionError('invalid qualification text', 'FORMAT')
  return value
}

function requestedEffort(value: unknown): ResearchDriverSelection['effort'] {
  const effort = object(value)
  if (effort.kind === 'required') return { kind: 'required', value: string(effort.value) }
  if (effort.kind === 'not-requested' || effort.kind === 'not-applicable') return { kind: effort.kind }
  throw new ResearchActionError('invalid requested qualification effort', 'FORMAT')
}

function observedEffort(value: unknown): ResearchObservedEffort {
  const effort = object(value)
  if (effort.kind === 'observed') return { kind: 'observed', value: string(effort.value) }
  if (effort.kind === 'not_observed' || effort.kind === 'not-applicable') return { kind: effort.kind }
  throw new ResearchActionError('invalid observed qualification effort', 'FORMAT')
}

/**
 * Parse one actual qualification without filling unknown observations from requested settings.
 * @param value - Driver or durable JSON observation.
 * @returns Explicit availability and observed fields; no execution permission is created.
 */
export function parseResearchQualification(value: unknown): ResearchDriverQualification {
  const record = object(value)
  if (record.status === 'unsupported' || record.status === 'not_observed') {
    return { status: record.status, reason: string(record.reason) }
  }
  if (record.status !== 'available') throw new ResearchActionError('invalid qualification status', 'FORMAT')
  const target = object(record.target)
  const selection = object(record.selection)
  if (!Array.isArray(selection.tools) || selection.tools.some(x => typeof x !== 'string' || !x)
    || new Set(selection.tools).size !== selection.tools.length
    || target.conversation !== null && (typeof target.conversation !== 'string' || !target.conversation)
    || !Number.isSafeInteger(record.inputMaxBytes) || (record.inputMaxBytes as number) < 1) {
    throw new ResearchActionError('invalid qualification fields', 'FORMAT')
  }
  return {
    status: 'available', requestSha256: string(record.requestSha256),
    target: { workspace: string(target.workspace), page: string(target.page), conversation: target.conversation },
    selection: { model: string(selection.model), mode: string(selection.mode), effort: requestedEffort(selection.effort),
      tools: [...selection.tools as string[]].sort() },
    effort: observedEffort(record.effort), inputMaxBytes: record.inputMaxBytes as number, evidence: string(record.evidence),
  }
}
