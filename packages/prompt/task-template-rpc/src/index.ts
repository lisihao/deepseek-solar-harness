/** Trusted Host RPC management surface for the private task-template store. */
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler, HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import {
  TASK_TEMPLATE_VARIABLES,
  taskTemplateId,
  type TaskAttributes,
  type TaskTemplateDraft,
  type TaskTemplateMatch,
  type TaskTemplatePatch,
  type TaskTemplatePersonalization,
  type TaskTemplateService,
} from '@deepseek-ai/dsh-task-template'
import { TASK_TEMPLATE_RPC_CHANNEL, type TaskTemplateRpcSnapshotV1 } from './shared.ts'

export { TASK_TEMPLATE_RPC_CHANNEL } from './shared.ts'
export type * from './shared.ts'

export const name = 'task-template-rpc'
export const inject = ['taskTemplates', 'connection']

type RpcResult = Awaited<ReturnType<ConnectionRpcHandler>>

function object(value: unknown, at = 'payload'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${at} must be an object`)
  return value as Record<string, unknown>
}

function string(value: unknown, at: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${at} must be a non-blank string`)
  return value
}

function exact(record: Record<string, unknown>, allowed: readonly string[], at = 'payload'): void {
  const supported = new Set(allowed)
  const unknown = Object.keys(record).find(key => !supported.has(key))
  if (unknown !== undefined) throw new TypeError(`${at} has unsupported key ${JSON.stringify(unknown)}`)
}

function strings(value: unknown, at: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${at} must be an array`)
  return value.map((entry, index) => string(entry, `${at}[${String(index)}]`))
}

function taskAttributes(value: unknown): TaskAttributes {
  const attributes = object(value, 'payload.attributes')
  exact(attributes, [
    'taskType', 'domain', 'objective', 'outputFormat', 'riskLevel',
    'tools', 'skills', 'operators', 'language', 'priority',
  ], 'payload.attributes')
  const riskLevel = string(attributes['riskLevel'], 'payload.attributes.riskLevel')
  if (riskLevel !== 'low' && riskLevel !== 'medium' && riskLevel !== 'high' && riskLevel !== 'critical') {
    throw new TypeError('payload.attributes.riskLevel is invalid')
  }
  const priority = string(attributes['priority'], 'payload.attributes.priority')
  if (priority !== 'low' && priority !== 'normal' && priority !== 'high' && priority !== 'urgent') {
    throw new TypeError('payload.attributes.priority is invalid')
  }
  return {
    taskType: string(attributes['taskType'], 'payload.attributes.taskType'),
    domain: string(attributes['domain'], 'payload.attributes.domain'),
    objective: string(attributes['objective'], 'payload.attributes.objective'),
    outputFormat: string(attributes['outputFormat'], 'payload.attributes.outputFormat'),
    riskLevel,
    tools: strings(attributes['tools'], 'payload.attributes.tools'),
    skills: strings(attributes['skills'], 'payload.attributes.skills'),
    operators: strings(attributes['operators'], 'payload.attributes.operators'),
    language: string(attributes['language'], 'payload.attributes.language'),
    priority,
  }
}

function success(value: unknown): RpcResult {
  return { ok: true, value: value as never }
}

function failure(error: unknown): RpcResult {
  return {
    ok: false,
    error: {
      code: 'bad-request',
      message: error instanceof Error ? error.message : String(error),
      details: { issues: [] },
    },
  }
}

function snapshot(service: TaskTemplateService): TaskTemplateRpcSnapshotV1 {
  return {
    version: 1,
    variables: TASK_TEMPLATE_VARIABLES,
    templates: service.list().map((template) => {
      const personalization = service.personalization(template.id)
      return {
        ...template,
        ...personalization === undefined ? {} : { personalization },
      }
    }),
  }
}

/** Create the strict endpoint dispatcher used by Host composition and tests. */
export function createTaskTemplateRpcHandler(service: TaskTemplateService): ConnectionRpcHandler {
  return async (endpoint, rawPayload) => {
    try {
      const payload = object(rawPayload)
      if (endpoint === 'list') {
        exact(payload, [])
        return success(snapshot(service))
      }
      if (endpoint === 'create') {
        exact(payload, ['draft'])
        const draft = object(payload['draft'], 'payload.draft')
        exact(draft, ['id', 'name', 'method', 'rank', 'match'], 'payload.draft')
        await service.create({
          id: taskTemplateId(string(draft['id'], 'payload.draft.id')),
          name: string(draft['name'], 'payload.draft.name'),
          method: string(draft['method'], 'payload.draft.method'),
          ...draft['rank'] === undefined ? {} : { rank: draft['rank'] as number },
          ...draft['match'] === undefined ? {} : { match: draft['match'] as TaskTemplateMatch },
        } satisfies TaskTemplateDraft)
        return success(snapshot(service))
      }
      const id = taskTemplateId(string(payload['id'], 'payload.id'))
      if (endpoint === 'update') {
        exact(payload, ['id', 'patch'])
        const patch = object(payload['patch'], 'payload.patch')
        exact(patch, ['name', 'method', 'rank', 'match'], 'payload.patch')
        await service.update(id, patch as TaskTemplatePatch)
      } else if (endpoint === 'set-enabled') {
        exact(payload, ['id', 'enabled'])
        if (typeof payload['enabled'] !== 'boolean') throw new TypeError('payload.enabled must be a boolean')
        await service.setEnabled(id, payload['enabled'])
      } else if (endpoint === 'delete') {
        exact(payload, ['id'])
        await service.delete(id)
      } else if (endpoint === 'personalize') {
        exact(payload, ['id', 'personalization'])
        const personal = payload['personalization']
        const personalization = personal === null || personal === undefined
          ? undefined
          : object(personal, 'payload.personalization')
        if (personalization !== undefined) {
          exact(personalization, ['preferences', 'memory'], 'payload.personalization')
        }
        await service.personalize(
          id,
          personalization as TaskTemplatePersonalization | undefined,
        )
      } else if (endpoint === 'preview') {
        exact(payload, ['id', 'attributes'])
        return success(service.select({ attributes: taskAttributes(payload['attributes']), explicitTemplateId: id }))
      } else {
        throw new TypeError(`unknown task-template endpoint: ${endpoint}`)
      }
      return success(snapshot(service))
    } catch (error) {
      return failure(error)
    }
  }
}

/** Register the private template store on the authenticated trusted-Host RPC. */
export function apply(ctx: Context): void {
  const connection = ctx.get('connection') as HostConnectionHandle
  ctx.effect(
    () => connection.rpc.handle(
      TASK_TEMPLATE_RPC_CHANNEL,
      createTaskTemplateRpcHandler(ctx.taskTemplates),
      { authority: 'trusted-host' },
    ),
    'task-template-rpc: trusted management channel',
  )
}
