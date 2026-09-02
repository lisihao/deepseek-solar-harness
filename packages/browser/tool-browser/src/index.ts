/**
 * Model-facing closed-plan browser Consumer over `ctx.browser`.
 *
 * The model never receives the Provider's programmable JavaScript surface.
 * Trusted plugins can inject `ctx.browser` directly when they need it; this
 * Consumer accepts only the portable v1 operation vocabulary.
 *
 * @module @deepseek-ai/dsh-tool-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  BrowserOperationId,
  BrowserPageKey,
  BrowserWorkspaceId,
  type BrowserOperationResultV1,
  type BrowserOperationV1,
  type BrowserRunPlanV1,
  type BrowserRunResultV1,
  type BrowserWorkspaceSelectorV1,
} from '@deepseek-ai/dsh-browser'
import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
import { z as zod } from 'zod'
import type {} from '@deepseek-ai/dsh-system-prompt'

export const name = 'tool-browser'
export const inject = ['browser', 'tools', 'systemPrompt']

const nonBlank = zod.string().trim().min(1)
const operationId = nonBlank
const pageKey = nonBlank
const timeout = zod.number().int().positive().optional()
const envelope = { id: operationId, timeoutMs: timeout }

const pageMatchSchema = zod.discriminatedUnion('kind', [
  zod.object({ kind: zod.literal('exact-url'), url: nonBlank }).strict(),
  zod.object({ kind: zod.literal('url-prefix'), prefix: nonBlank }).strict(),
])

const locatorSchema = zod.discriminatedUnion('kind', [
  zod.object({ kind: zod.literal('css'), selector: nonBlank, index: zod.number().int().nonnegative().optional() }).strict(),
  zod.object({ kind: zod.literal('role'), role: nonBlank, name: zod.string().optional(), exact: zod.boolean().optional(), index: zod.number().int().nonnegative().optional() }).strict(),
  zod.object({ kind: zod.literal('text'), text: nonBlank, exact: zod.boolean().optional(), index: zod.number().int().nonnegative().optional() }).strict(),
  zod.object({ kind: zod.literal('label'), label: nonBlank, exact: zod.boolean().optional(), index: zod.number().int().nonnegative().optional() }).strict(),
  zod.object({ kind: zod.literal('placeholder'), placeholder: nonBlank, exact: zod.boolean().optional(), index: zod.number().int().nonnegative().optional() }).strict(),
  zod.object({ kind: zod.literal('test-id'), testId: nonBlank, index: zod.number().int().nonnegative().optional() }).strict(),
])

const loadStateSchema = zod.enum(['dom-content-loaded', 'load', 'network-idle'])
const waitConditionSchema = zod.discriminatedUnion('kind', [
  zod.object({ kind: zod.literal('load'), page: pageKey, state: loadStateSchema }).strict(),
  zod.object({ kind: zod.literal('url'), page: pageKey, match: pageMatchSchema }).strict(),
  zod.object({ kind: zod.literal('locator'), page: pageKey, locator: locatorSchema, state: zod.enum(['attached', 'detached', 'visible', 'hidden']) }).strict(),
  zod.object({ kind: zod.literal('control'), control: zod.enum(['agent', 'user']) }).strict(),
])

const readTargetSchema = zod.discriminatedUnion('kind', [
  zod.object({ kind: zod.literal('text') }).strict(),
  zod.object({ kind: zod.literal('value') }).strict(),
  zod.object({ kind: zod.literal('html') }).strict(),
  zod.object({ kind: zod.literal('attribute'), name: nonBlank }).strict(),
])

/** Model-accessible operations. Screenshot and control transfer remain trusted-plugin-only. */
const operationSchema = zod.discriminatedUnion('kind', [
  zod.object({ ...envelope, kind: zod.literal('open'), page: pageKey, url: nonBlank, reuse: zod.enum(['never', 'exact-url']), waitUntil: loadStateSchema }).strict(),
  zod.object({ ...envelope, kind: zod.literal('select-page'), page: pageKey, match: pageMatchSchema }).strict(),
  zod.object({ ...envelope, kind: zod.literal('close-page'), page: pageKey }).strict(),
  zod.object({ ...envelope, kind: zod.literal('navigate'), page: pageKey, url: nonBlank, waitUntil: loadStateSchema }).strict(),
  zod.object({ ...envelope, kind: zod.literal('reload'), page: pageKey, waitUntil: loadStateSchema }).strict(),
  zod.object({ ...envelope, kind: zod.literal('pages') }).strict(),
  zod.object({ ...envelope, kind: zod.literal('page-info'), page: pageKey }).strict(),
  zod.object({ ...envelope, kind: zod.literal('snapshot'), page: pageKey }).strict(),
  zod.object({ ...envelope, kind: zod.literal('click'), page: pageKey, locator: locatorSchema }).strict(),
  zod.object({ ...envelope, kind: zod.literal('fill'), page: pageKey, locator: locatorSchema, value: zod.string() }).strict(),
  zod.object({ ...envelope, kind: zod.literal('clear'), page: pageKey, locator: locatorSchema }).strict(),
  zod.object({ ...envelope, kind: zod.literal('press'), page: pageKey, locator: locatorSchema, key: nonBlank }).strict(),
  zod.object({ ...envelope, kind: zod.literal('check'), page: pageKey, locator: locatorSchema, checked: zod.boolean() }).strict(),
  zod.object({ ...envelope, kind: zod.literal('select'), page: pageKey, locator: locatorSchema, values: zod.array(zod.string()).min(1) }).strict(),
  zod.object({ ...envelope, kind: zod.literal('read'), page: pageKey, locator: locatorSchema, target: readTargetSchema }).strict(),
  zod.object({ ...envelope, kind: zod.literal('count'), page: pageKey, locator: locatorSchema }).strict(),
  zod.object({ ...envelope, kind: zod.literal('wait'), condition: waitConditionSchema }).strict(),
  zod.object({ ...envelope, kind: zod.literal('complete'), keep: zod.boolean() }).strict(),
])

const workspaceSchema = zod.discriminatedUnion('kind', [
  zod.object({ kind: zod.literal('current') }).strict(),
  zod.object({ kind: zod.literal('existing'), id: nonBlank }).strict(),
  zod.object({ kind: zod.literal('named'), name: nonBlank, createIfMissing: zod.boolean() }).strict(),
])

const planSchema = zod.object({
  version: zod.literal(1),
  workspace: workspaceSchema,
  requiredCapabilities: zod.array(zod.enum([
    'authenticated-profile-reuse', 'named-workspace', 'page-evaluate',
    'semantic-snapshot',
  ])).default([]),
  operations: zod.array(operationSchema).min(1).max(64),
}).strict()

type PortablePlanInput = zod.infer<typeof planSchema>

/** Validate the model boundary and brand only already-validated plan-local ids. */
export function parseBrowserPlan(input: unknown): BrowserRunPlanV1 {
  const parsed = planSchema.parse(input)
  const workspace: BrowserWorkspaceSelectorV1 = parsed.workspace.kind === 'existing'
    ? { kind: 'existing', id: BrowserWorkspaceId(parsed.workspace.id) }
    : parsed.workspace
  const operations = parsed.operations.map(operation => brandOperation(operation))
  return {
    version: 1,
    workspace,
    requiredCapabilities: parsed.requiredCapabilities,
    operations,
  }
}

function brandOperation(operation: PortablePlanInput['operations'][number]): BrowserOperationV1 {
  const { id, timeoutMs, ...body } = operation
  const withId = {
    ...body,
    id: BrowserOperationId(id),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }
  switch (operation.kind) {
    case 'open':
    case 'close-page':
    case 'navigate':
    case 'reload':
    case 'page-info':
    case 'snapshot':
    case 'click':
    case 'fill':
    case 'clear':
    case 'press':
    case 'check':
    case 'select':
    case 'read':
    case 'count':
      return { ...withId, page: BrowserPageKey(operation.page) } as BrowserOperationV1
    case 'select-page':
      return { ...withId, page: BrowserPageKey(operation.page) } as BrowserOperationV1
    case 'wait':
      return operation.condition.kind === 'control'
        ? withId as BrowserOperationV1
        : { ...withId, condition: { ...operation.condition, page: BrowserPageKey(operation.condition.page) } } as BrowserOperationV1
    case 'pages':
    case 'complete':
      return withId as BrowserOperationV1
  }
  const exhaustive: never = operation
  return exhaustive
}

function operationValue(operation: BrowserOperationResultV1): JsonValue {
  return JSON.parse(JSON.stringify(operation)) as JsonValue
}

/** Convert branded seam values to the tool's JSON-only durable value. */
export function resultValue(result: BrowserRunResultV1): Record<string, JsonValue> {
  return {
    version: result.version,
    workspace: JSON.parse(JSON.stringify(result.workspace)) as JsonValue,
    operations: result.operations.map(operationValue),
  }
}

export const browserGuidance = 'Use the browser tool when a task requires interacting with a real webpage, especially one that benefits from the user\'s existing browser login. Submit one ordered portable plan with the fewest necessary operations. Prefer semantic snapshots and role/label/text locators over CSS. Reuse a named workspace only when continuity matters. Never assume a click or form submission succeeded: read the resulting state in the same plan. If the browser reports user control or an inactive workspace, stop and report it; do not retry, take control, or recreate the task automatically.'

/** Register the portable model Consumer; Provider selection remains in ctx.browser. */
export function apply(ctx: Context): void {
  ctx.systemPrompt.section({ name: 'tool:browser', order: 111, text: browserGuidance })
  ctx.tools.register(defineTool({
    name: 'browser',
    description: 'Run an ordered, typed browser plan through the configured browser provider. Uses persistent browser workspaces and existing login state when supported.',
    parameters: {
      plan: { type: 'json', required: true, description: 'BrowserRunPlanV1: {version:1, workspace, requiredCapabilities, operations}. Operations are bounded to 64 and execute in order.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: { plan: JsonValue }, exec) {
      return resultValue(await ctx.browser.runPlan(parseBrowserPlan(args.plan), exec.signal))
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Browser plan',
      kind: 'other',
      rawInput: JSON.stringify(args.plan),
    }),
  }))
}
