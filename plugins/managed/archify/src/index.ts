import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { executeArchify, type ArchifyConfig } from './runner.ts'
import { ARCHIFY_ACTIONS, ARCHIFY_DIAGRAM_TYPES, type ArchifyToolArgs } from './types.ts'

export const name = '@deepseek-ai/dsh-archify'
export const inject = ['tools', 'systemPrompt', 'subprocess']

export interface Config extends ArchifyConfig {
  readonly promptSectionOrder?: number
}

export const Config: z<Config> = z.object({
  artifactRoot: z.string().default(''),
  timeoutMs: z.natural().min(1).default(120_000),
  maxCaptureBytes: z.natural().min(1024).default(16_384),
  maxOutputBytes: z.natural().min(1024).default(32_000_000),
  promptSectionOrder: z.natural().default(116),
})

const ARCHIFY_GUIDANCE = `Archify is the DSH diagram skill backed by the exact Archify v2.16.0 runtime (five typed JSON IR diagram types: architecture, workflow, sequence, dataflow, lifecycle). Use the archify tool when an architecture, system design, workflow, API sequence, dataflow, lifecycle, requirements, or review task materially benefits from a diagram; do not call it for greetings or simple prose. Provide a typed JSON IR object, run validate before deliver, and return artifactRef/receiptRef rather than inlining large HTML. Use compare only for two architecture IR objects. The adapter preserves Archify's strict schemas, diagnostics, geometry checks, repository-evidence rules, and content-addressed receipts. Never invent repository evidence; pass repoRoot only when the user asked for a code-grounded architecture diagram. The tool does not silently fall back to another renderer.`

const ARCHIFY_DESCRIPTION = 'Create and validate Archify diagrams from typed JSON IR. Actions: render, validate, deliver, compare (architecture only), inspect, guide, doctor, visual-check, examples, brands, migrate (workflow v1→v2). Use five types: architecture, workflow, sequence, dataflow, lifecycle. Results are bounded and return content-addressed artifact and receipt refs; large HTML is never inlined.'

const parameters = {
  action: {
    type: 'string',
    required: true,
    enum: ARCHIFY_ACTIONS,
    description: 'Archify operation.',
  },
  type: {
    type: 'string',
    enum: ARCHIFY_DIAGRAM_TYPES,
    description: 'Diagram type for render/validate/deliver; compare and inspect use architecture.',
  },
  input: {
    type: 'json',
    description: 'One typed JSON IR object for render, validate, deliver, or inspect.',
  },
  baseInput: {
    type: 'json',
    description: 'Base architecture JSON IR object for compare.',
  },
  headInput: {
    type: 'json',
    description: 'Head architecture JSON IR object for compare.',
  },
  quality: {
    type: 'string',
    enum: ['standard', 'showcase'],
    description: 'Optional upstream quality profile.',
  },
  repoRoot: {
    type: 'string',
    description: 'Optional repository root for architecture source-evidence validation.',
  },
  outputName: {
    type: 'string',
    description: 'Optional safe filename for deliver output; it is published under the plugin artifact root.',
  },
  htmlPath: {
    type: 'string',
    description: 'Existing HTML path inside the plugin artifact root for visual-check.',
  },
  scenario: {
    type: 'string',
    description: 'Scenario or question for guide.',
  },
  language: {
    type: 'string',
    enum: ['en', 'zh'],
    description: 'Guide language.',
  },
  query: {
    type: 'string',
    description: 'Brand catalog query for brands.',
  },
  captureUrl: {
    type: 'string',
    description: 'User-provided URL for brands capture; this may access the network and is never inferred.',
  },
  migrateToSchema: {
    type: 'string',
    enum: ['2'],
    description: 'Target workflow schema for migrate; Archify v2.16.0 supports 2.',
  },
} as const

function renderResult(_args: ArchifyToolArgs, value: JsonValue): [{ type: 'text'; text: string }] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

export function apply(ctx: Context, config: Config): void {
  ctx.systemPrompt.section({
    name: 'archify:usage',
    order: config.promptSectionOrder ?? 116,
    text: ARCHIFY_GUIDANCE,
  })
  ctx.tools.register(defineTool({
    name: 'archify',
    description: ARCHIFY_DESCRIPTION,
    parameters,
    output: {
      schema: { type: 'json' },
      render: renderResult,
    },
    timeoutMs: config.timeoutMs ?? 120_000,
    execute: (args, exec) => executeArchify(args as ArchifyToolArgs, exec, config, ctx.subprocess) as unknown as Promise<JsonValue>,
  }))
}

export type {
  ArchifyAction,
  ArchifyArtifactRef,
  ArchifyDiagramType,
  ArchifyError,
  ArchifyQuality,
  ArchifyToolArgs,
  ArchifyToolResult,
} from './types.ts'
export { ARCHIFY_ACTIONS, ARCHIFY_DIAGRAM_TYPES } from './types.ts'
export { executeArchify } from './runner.ts'
export type { ArchifySubprocess } from './runner.ts'
